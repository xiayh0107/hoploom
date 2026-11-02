// Pinned official Astral uv 0.13.6 release assets; SHA-256 from GitHub release metadata.
export const UV_VERSION = "0.13.6"
export const uvAssets: Record<string, { filename: string; sha256: string }> = {
  "darwin-arm64": {
    "filename": "uv-aarch64-apple-darwin.tar.gz",
    "sha256": "60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472"
  },
  "win32-arm64": {
    "filename": "uv-aarch64-pc-windows-msvc.zip",
    "sha256": "c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c"
  },
  "linux-arm64": {
    "filename": "uv-aarch64-unknown-linux-gnu.tar.gz",
    "sha256": "229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d"
  },
  "darwin-x64": {
    "filename": "uv-x86_64-apple-darwin.tar.gz",
    "sha256": "63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02"
  },
  "win32-x64": {
    "filename": "uv-x86_64-pc-windows-msvc.zip",
    "sha256": "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f"
  },
  "linux-x64": {
    "filename": "uv-x86_64-unknown-linux-gnu.tar.gz",
    "sha256": "f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645"
  }
}
