"""Private dsh transport for Hoploom's existing application (not a public CLI).

The parent supplies a random transport key over stdin. Only authenticated dsh
owner requests reach this loopback listener; each frame has its own web session.
No request bodies, session identifiers or credentials are written to output.
"""
from __future__ import annotations

import contextvars
from contextlib import asynccontextmanager
import ipaddress
import json
import re
import secrets
import socket
import sys
from urllib.parse import urlsplit

import uvicorn
from ssh_server_manager.auth import AuthenticationError, RevealAuth
from ssh_server_manager.db import Database
from ssh_server_manager.paths import database_path
from ssh_server_manager.webapp import SESSION_COOKIE, create_app

origin_context = contextvars.ContextVar('dsh_ui_origin', default='')


class EmbeddedRevealAuth:
    """Keep challenges and expected origins separate for each browser origin."""
    def __init__(self, database):
        self.database = database
        self.origins = {}

    def current(self):
        origin = origin_context.get()
        if origin not in self.origins:
            host = urlsplit(origin).hostname or ''
            self.origins[origin] = RevealAuth(self.database, rp_id=host, origin=origin)
        return self.origins[origin]

    def supported(self):
        origin = urlsplit(origin_context.get())
        if origin.scheme not in {'http', 'https'} or not origin.hostname:
            return False
        try:
            ipaddress.ip_address(origin.hostname)
            return False  # WebAuthn RP identifiers cannot be IP addresses.
        except ValueError:
            return origin.scheme == 'https' or origin.hostname == 'localhost'

    def status(self):
        status = self.current().status()
        status['webauthn_available'] = status['webauthn_available'] and self.supported()
        return status

    def __getattr__(self, name):
        if name in {'begin_registration', 'finish_registration', 'begin_authentication', 'finish_authentication'} and not self.supported():
            raise AuthenticationError('Passkeys are unavailable in this view; use the local master password.')
        return getattr(self.current(), name)


class PrivateUi:
    def __init__(self, app, key):
        self.app, self.key = app, key
        self.frames = {}
        app.state.web.auth = EmbeddedRevealAuth(app.state.web.database)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = dict(scope['headers'])
        supplied = headers.get(b'authorization', b'').decode('ascii', errors='ignore')
        if not secrets.compare_digest(supplied, 'Bearer ' + self.key):
            return await self.reject(send, 403)
        frame = headers.get(b'x-hoploom-frame', b'').decode('ascii', errors='ignore')
        origin = headers.get(b'x-hoploom-origin', b'').decode('ascii', errors='ignore')
        if not re.fullmatch(r'[a-f0-9]{64}', frame) or len(origin) > 512:
            return await self.reject(send, 400)
        state = self.app.state.web
        state.clean()
        self.frames = {key: value for key, value in self.frames.items() if value[0] in state.sessions}
        if scope['path'] == '/bridge/release' and scope['method'] == 'POST':
            saved = self.frames.pop(frame, None)
            if saved:
                state.operations.cancel_session(saved[0])
                state.sessions.pop(saved[0], None)
                for auth in state.auth.origins.values():
                    auth.pending.pop(saved[0], None)
            return await self.reject(send, 204)
        if not scope['path'].startswith('/api/v1/'):
            return await self.reject(send, 404)
        saved = self.frames.get(frame)
        if saved is None:
            if scope['path'] != '/api/v1/runtime' or scope['method'] != 'GET' or len(self.frames) >= 128:
                return await self.reject(send, 401)
            identifier, _ = state.create_session()
            saved = self.frames[frame] = (identifier, origin)
        if saved[1] != origin:
            return await self.reject(send, 403)
        cleaned = [(key, value) for key, value in scope['headers'] if key not in {
            b'host', b'origin', b'cookie', b'authorization', b'x-hoploom-frame', b'x-hoploom-origin',
        }]
        cleaned += [(b'host', state.origin.removeprefix('http://').encode()),
                    (b'origin', state.origin.encode()),
                    (b'cookie', f'{SESSION_COOKIE}={saved[0]}'.encode())]
        token = origin_context.set(origin)
        try:
            await self.app({**scope, 'headers': cleaned}, receive, send)
        finally:
            origin_context.reset(token)

    @staticmethod
    async def reject(send, status):
        await send({'type': 'http.response.start', 'status': status, 'headers': [(b'cache-control', b'no-store')]})
        await send({'type': 'http.response.body', 'body': b''})


def main():
    settings = json.loads(sys.stdin.buffer.readline(4096))
    key = settings.get('key', '')
    if not re.fullmatch(r'[a-f0-9]{64}', key):
        raise SystemExit(2)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    app = create_app(Database(database_path()), launch_token=secrets.token_urlsafe(32), port=port)
    wrapped = PrivateUi(app, key)
    # The port is public metadata; the transport key never leaves private stdin.
    lifecycle = app.router.lifespan_context
    @asynccontextmanager
    async def ready(application):
        async with lifecycle(application):
            print(json.dumps({'port': port}), flush=True)
            yield
    app.router.lifespan_context = ready
    server = uvicorn.Server(uvicorn.Config(wrapped, host='127.0.0.1', port=port,
        log_level='critical', access_log=False, timeout_graceful_shutdown=3))
    try:
        server.run(sockets=[sock])
    finally:
        sock.close()


if __name__ == '__main__':
    main()
