"""Route selection for remote directory listings.

SFTP is the listing and transfer authority: a transfer is authorized from a
``stat_file`` that SFTP answers. Browsing may instead run one shell exec, which
is what makes a high-latency host usable, but only once the shell provably
resolves paths the way SFTP does — a chroot or a ``ForceCommand`` jail makes the
same string name two different files.

This module owns that policy and the state behind it:

* a per-host namespace verdict, cached because proving it costs a full SFTP
  handshake, and expiring because a jail, a home directory or the host identity
  can change while the app runs;
* a short back-off for hosts that cannot answer at all, so a repeated failure is
  not paid on every folder while a host that recovers is picked back up without
  restarting the app;
* one in-flight probe per host, so concurrent requests never pay for the same
  check twice.

Every answer here expires. Nothing in this module can pin a host to one route
for the lifetime of the process, which is what a plain dictionary of verdicts
did.

The remote I/O stays in :class:`~ssh_server_manager.ssh_runner.SSHRunner`.
Everything here is policy and bookkeeping, which is also why it can be tested
without a host.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from .operations import OperationContext, OperationTimeout, bind_operation, current_operation

# A jail or a home directory does not move every few seconds, but it can move
# while the app runs (a re-provisioned account, a rebuilt container, a host that
# was repointed). Expiring keeps a stale verdict from outliving that change.
NAMESPACE_VERDICT_TTL_SECONDS = 600.0

# How long a host that could not answer at all is left alone before it is tried
# again. Long enough that walking folder by folder does not re-pay the failure,
# short enough that a recovered host needs no restart.
UNAVAILABLE_BACKOFF_SECONDS = 120.0

# Transport outcomes that already say the shell route cannot answer: the
# connection never got far enough to have an opinion about Python or namespaces.
TRANSPORT_FAILURE_CODES = frozenset(
    {"ssh-failed", "connection-refused", "auth_failed", "ssh-not-found", "unreachable"}
)


@dataclass(frozen=True)
class _Verdict:
    """One namespace answer, tied to the identity it was proven for."""

    identity: tuple[str, int, str]
    matched: bool
    expires_at: float


@dataclass
class _ProbeFlight:
    operation: OperationContext
    consumers: int = 0
    done: threading.Event = field(default_factory=threading.Event)
    answer: bool | None = None
    error: BaseException | None = None


def host_identity(server: dict[str, Any]) -> tuple[str, int, str]:
    """What a namespace verdict actually depends on.

    The home directory is part of the answer, so a changed user invalidates the
    verdict just as a repointed hostname or port does.
    """
    return (str(server.get("hostname") or ""), int(server.get("port") or 0), str(server.get("username") or ""))


class ListingRoute:
    """Decides whether a directory may be listed through the shell.

    Not a cache of listings: only the two facts that are expensive to re-prove
    and cheap to remember, and only until they expire.
    """

    def __init__(
        self,
        *,
        ttl: float = NAMESPACE_VERDICT_TTL_SECONDS,
        backoff: float = UNAVAILABLE_BACKOFF_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.ttl = ttl
        self.backoff = backoff
        self._clock = clock
        self._guard = threading.Lock()
        self._verdicts: dict[str, _Verdict] = {}
        self._deferred: dict[str, tuple[tuple[str, int, str], float]] = {}
        self._flights: dict[str, threading.Lock] = {}
        self._shared_flights: dict[tuple[str, tuple[str, int, str]], _ProbeFlight] = {}

    # -- may the fast route be attempted at all? ---------------------------

    def may_try(self, server: dict[str, Any]) -> bool:
        """False when this host is known not to answer the shell listing.

        Checked before the attempt, not after: a host whose shell is jailed or
        has no Python would otherwise pay one discarded exec per folder. A host
        that is merely unproven still runs the listing first, so it never pays
        for a namespace check before it knows there is an answer to authorize.
        """
        if (server.get("last_test_status") == "failed"
                and server.get("last_test_error_code") in TRANSPORT_FAILURE_CODES):
            return False
        identity = host_identity(server)
        with self._guard:
            verdict = self._verdicts.get(server["id"])
            if verdict is not None:
                if verdict.identity == identity and self._clock() < verdict.expires_at:
                    if not verdict.matched:
                        return False
                else:
                    del self._verdicts[server["id"]]
            deferred = self._deferred.get(server["id"])
            if deferred is not None:
                deferred_identity, expires_at = deferred
                if deferred_identity == identity and self._clock() < expires_at:
                    return False
                del self._deferred[server["id"]]
            return True

    def defer(self, server: dict[str, Any]) -> None:
        """Stop trying this host for ``backoff`` seconds."""
        with self._guard:
            self._deferred[server["id"]] = (host_identity(server), self._clock() + self.backoff)

    def answered(self, server: dict[str, Any]) -> None:
        """The shell listing answered, so stop skipping this host."""
        with self._guard:
            self._deferred.pop(server["id"], None)

    # -- the namespace verdict ---------------------------------------------

    def namespace_matches(self, server: dict[str, Any], probe: Callable[[], bool | None]) -> bool:
        """Whether SFTP and the shell agree, asking ``probe`` at most once.

        ``probe`` returns ``None`` when it could not reach a verdict (a timeout,
        no answer, no shell). That is a property of the attempt rather than of
        the host, so no verdict is recorded — but the host is deferred, because
        otherwise every folder would pay the same fruitless handshake.
        """
        key = server["id"]
        identity = host_identity(server)
        remembered = self._remembered(key, identity)
        if remembered is not None:
            return remembered
        operation = current_operation()
        if operation is not None:
            return self._shared_namespace(server, probe, operation)
        # One probe per host: a concurrent request waits for the first verdict
        # instead of paying the same handshake again.
        with self._flight(key):
            remembered = self._remembered(key, identity)
            if remembered is not None:
                return remembered
            verdict = probe()
            if verdict is None:
                self.defer(server)
                return False
            self.record(server, matched=bool(verdict))
            return bool(verdict)

    def _shared_namespace(self, server: dict[str, Any], probe: Callable[[], bool | None], consumer: OperationContext) -> bool:
        key = (server["id"], host_identity(server))
        while True:
            consumer.check()
            with self._guard:
                flight = self._shared_flights.get(key)
                closing = flight is not None and flight.operation.canceled.is_set() and not flight.done.is_set()
                if not closing:
                    created = flight is None
                    if created:
                        flight = _ProbeFlight(OperationContext(consumer.host_id, consumer.remaining()))
                        self._shared_flights[key] = flight
                    assert flight is not None
                    flight.consumers += 1
                    break
            consumer.canceled.wait(min(0.025, consumer.remaining()))

        assert flight is not None
        def run() -> None:
            try:
                with bind_operation(flight.operation):
                    flight.answer = probe()
                    flight.operation.check()
                if flight.answer is None:
                    self.defer(server)
                else:
                    self.record(server, matched=bool(flight.answer))
            except BaseException as exc:
                flight.error = exc
            finally:
                flight.operation.finish()
                flight.done.set()
                with self._guard:
                    if not flight.consumers and self._shared_flights.get(key) is flight:
                        self._shared_flights.pop(key)
        if created:
            threading.Thread(target=run, name="hoploom-namespace-probe", daemon=True).start()
        try:
            while not flight.done.wait(min(0.025, consumer.remaining())):
                consumer.check()
            consumer.check()
            if flight.error is not None:
                if isinstance(flight.error, OperationTimeout):
                    return False  # This consumer may still have fallback time.
                raise flight.error
            return bool(flight.answer)
        finally:
            with self._guard:
                flight.consumers -= 1
                if not flight.consumers:
                    if flight.done.is_set():
                        if self._shared_flights.get(key) is flight:
                            self._shared_flights.pop(key)
                    else:
                        flight.operation.cancel()

    def record(self, server: dict[str, Any], *, matched: bool) -> None:
        """Remember one namespace answer for ``ttl`` seconds."""
        with self._guard:
            self._verdicts[server["id"]] = _Verdict(
                host_identity(server), matched, self._clock() + self.ttl,
            )
            if matched:
                self._deferred.pop(server["id"], None)

    def _remembered(self, key: str, identity: tuple[str, int, str]) -> bool | None:
        with self._guard:
            verdict = self._verdicts.get(key)
            if verdict is None:
                return None
            if verdict.identity != identity or self._clock() >= verdict.expires_at:
                del self._verdicts[key]
                return None
            return verdict.matched

    def _flight(self, key: str) -> threading.Lock:
        with self._guard:
            return self._flights.setdefault(key, threading.Lock())

    # -- lifecycle ----------------------------------------------------------

    def forget(self, server_id: str | None = None) -> None:
        """Drop remembered state, for one host or for all of them."""
        with self._guard:
            if server_id is None:
                self._verdicts.clear()
                self._deferred.clear()
            else:
                self._verdicts.pop(server_id, None)
                self._deferred.pop(server_id, None)
