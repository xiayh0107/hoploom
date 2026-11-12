Tag discovery is vendored unchanged from PyPA packaging 26.3, installed from
PyPI. Only `tags` and its standard-library-only platform helpers are included.
It runs inside the managed Python, before wheel installation, so selection uses
that interpreter's ABI, architecture, libc and macOS deployment compatibility.
It does not infer Python compatibility from the Node.js process architecture.

Upstream: https://github.com/pypa/packaging/tree/26.3/src/packaging
API: https://packaging.pypa.io/en/stable/tags.html
The accompanying LICENSE, LICENSE.APACHE and LICENSE.BSD are preserved.
