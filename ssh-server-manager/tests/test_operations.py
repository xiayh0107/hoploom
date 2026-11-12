from __future__ import annotations

import asyncio
import contextvars
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from ssh_server_manager.operations import (
    CancellationToken, ExecutionUnavailable, OperationBusy, OperationCancelled,
    OperationContext, OperationScheduler, OperationTimeout, current_operation,
)


def test_nested_helpers_and_to_thread_share_one_permit():
    scheduler = OperationScheduler(active=1, per_host=1)
    root = OperationContext("host", 3)
    with scheduler.scope(root):
        with scheduler.scope(OperationContext("host", 3)) as child:
            assert child is root
            assert scheduler.snapshot() == {"active": 1, "queued": 0, "transfers": 0}
        assert asyncio.run(asyncio.to_thread(current_operation)) is root
    assert current_operation() is None
    assert scheduler.snapshot()["active"] == 0


def test_full_queue_refuses_without_starting_and_canceled_waiter_frees_its_place():
    scheduler = OperationScheduler(active=1, per_host=1, queued=1)
    waiting = OperationContext("host", 3)
    queued = threading.Event()

    def wait():
        queued.set()
        with scheduler.scope(waiting):
            pytest.fail("Canceled waiter must never start")

    with ThreadPoolExecutor(max_workers=1) as pool:
        with scheduler.scope(OperationContext("host", 3)):
            future = pool.submit(wait)
            assert queued.wait(1)
            # The waiter has to acquire the scheduler lock before this check.
            for _ in range(100):
                if scheduler.snapshot()["queued"] == 1:
                    break
                waiting.canceled.wait(0.005)
            assert scheduler.snapshot()["queued"] == 1
            # Separate context: a helper inside the parent intentionally reuses it.
            def refused():
                with scheduler.scope(OperationContext("other", 1)):
                    pytest.fail("Full queue must refuse")
            with ThreadPoolExecutor(max_workers=1) as second:
                with pytest.raises(OperationBusy):
                    second.submit(refused).result(timeout=1)
            waiting.cancel()
            with pytest.raises(OperationCancelled):
                future.result(timeout=1)
            assert scheduler.snapshot()["queued"] == 0


def test_busy_host_does_not_block_other_hosts_and_session_cancel_is_scoped():
    scheduler = OperationScheduler(active=2, per_host=1)
    first = OperationContext("busy-host", 3, session_id="first")
    second = OperationContext("other-host", 3, session_id="second")
    entered = threading.Event()

    def work():
        with scheduler.scope(second):
            entered.set()
            assert second.canceled.wait(2)
            second.check()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with scheduler.scope(first):
            future = pool.submit(work)
            assert entered.wait(1)
            scheduler.cancel_session("second")
            with pytest.raises(OperationCancelled):
                future.result(timeout=1)
            first.check()
    assert scheduler.snapshot()["active"] == 0


def test_deadline_covers_queue_waiting_and_shutdown_cancels_active_work():
    scheduler = OperationScheduler(active=1, per_host=1)
    root = OperationContext("host", 3)
    def expired():
        with scheduler.scope(OperationContext("other", 0.02)):
            pytest.fail("Expired waiter must never start")
    with ThreadPoolExecutor(max_workers=1) as pool:
        with scheduler.scope(root):
            with pytest.raises(OperationTimeout):
                pool.submit(expired).result(timeout=1)
            scheduler.close()
            with pytest.raises(OperationCancelled):
                root.check()
    with pytest.raises(ExecutionUnavailable):
        with scheduler.scope(OperationContext("host", 1)):
            pass


def test_transfer_limit_is_shared_across_hosts_and_released_after_failure():
    scheduler = OperationScheduler(active=3, per_host=2, transfers=1, queued=0)
    def busy():
        with scheduler.scope(OperationContext("other", 1, transfer=True)):
            pytest.fail("Transfer cap must apply across hosts")
    with pytest.raises(ValueError):
        with scheduler.scope(OperationContext("host", 1, transfer=True)):
            with ThreadPoolExecutor(max_workers=1) as pool:
                with pytest.raises(OperationBusy):
                    pool.submit(busy).result(timeout=1)
            raise ValueError("failure")
    assert scheduler.snapshot() == {"active": 0, "queued": 0, "transfers": 0}


def test_cancellation_notifies_current_and_later_subscribers_once():
    token = CancellationToken()
    seen = []
    release = token.subscribe(lambda: seen.append("released"))
    release()
    token.subscribe(lambda: seen.append("current"))
    token.set(); token.set()
    token.subscribe(lambda: seen.append("late"))
    assert seen == ["current", "late"]


def test_async_admission_bounds_pending_workers_and_cancel_releases_waiter():
    async def scenario():
        scheduler = OperationScheduler(active=1, per_host=1, queued=1)
        waiting = OperationContext("second", 3)
        started = asyncio.Event()
        async def waiter():
            started.set()
            async with scheduler.async_scope(waiting):
                pytest.fail("A canceled queued request must not start a worker")
        async with scheduler.async_scope(OperationContext("first", 3)):
            task = contextvars.Context().run(asyncio.create_task, waiter())
            await started.wait()
            assert scheduler.snapshot()["queued"] == 1
            async def refuse():
                with pytest.raises(OperationBusy):
                    async with scheduler.async_scope(OperationContext("third", 1)):
                        pass
            await contextvars.Context().run(asyncio.create_task, refuse())
            waiting.cancel()
            with pytest.raises(OperationCancelled):
                await task
            assert scheduler.snapshot()["queued"] == 0
        assert scheduler.snapshot()["active"] == 0
    asyncio.run(scenario())


def test_bulk_checks_share_a_four_operation_cap_without_blocking_single_checks():
    async def scenario():
        scheduler = OperationScheduler()
        ready = asyncio.Queue()
        finish = asyncio.Event()
        async def bulk(index):
            async with scheduler.async_scope(OperationContext(str(index), 3, bulk=True)):
                ready.put_nowait(index)
                await finish.wait()
        tasks = [asyncio.create_task(bulk(index)) for index in range(8)]
        for _ in range(4):
            await asyncio.wait_for(ready.get(), 1)
        assert scheduler.snapshot()["active"] == 4
        assert scheduler.snapshot()["queued"] == 4
        async with scheduler.async_scope(OperationContext("single", 3)):
            assert scheduler.snapshot()["active"] == 5
        finish.set()
        await asyncio.gather(*tasks)
        assert scheduler.snapshot()["active"] == 0
    asyncio.run(scenario())
