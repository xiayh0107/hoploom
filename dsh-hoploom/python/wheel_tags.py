"""Discover the actual managed interpreter's tags before installing Hoploom.

No network, pip or third-party installation is needed. The private tag-discovery
subset is vendored unchanged from PyPA packaging 26.3 (see its license files).
"""
import json
from pathlib import Path
import sys
import sysconfig

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _hoploom_packaging.tags import sys_tags

supported = (sys.implementation.name == "cpython" and sys.version_info >= (3, 10)
             and not sysconfig.get_config_var("Py_GIL_DISABLED"))
print(json.dumps({"tags": [str(tag) for tag in sys_tags()
                           if tag.interpreter == "cp310" and tag.abi == "abi3"] if supported else []}))
