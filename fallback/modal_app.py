"""
LineCheck fallback route - open-weight Meta vision model, OpenAI-compatible, on Modal.

Why this exists
---------------
The demo's primary path is the Meta Model API (Muse Spark 1.3 / SAM 3.1). When that path is down,
rate-limited, or out of credits, the HUD must keep answering instead of dying on stage. This app
serves `meta-llama/Llama-3.2-11B-Vision-Instruct` through vLLM's OpenAI-compatible server, so the
fallback speaks the same wire format as the primary and only the base URL changes.

This file is infrastructure, not app code: it imports nothing from the harness and the harness does
not import it. The only contract between the two is HTTP + the bearer token in the Authorization
header, which is why `harness/proxy-server.mjs` can point at it with two env vars:

    META_OPEN_WEIGHTS_SPARK_URL=https://<workspace>--linecheck-fallback-serve.modal.run/v1/chat/completions
    MODAL_API_KEY=<same value as FALLBACK_API_KEY in the modal secret>
    FALLBACK_MODE=auto

Deploy
------
    pip install modal
    modal setup                                     # browser token, once
    modal secret create linecheck-fallback \\
        FALLBACK_API_KEY=... HF_TOKEN=hf_...        # never commit either
    modal deploy fallback/modal_app.py

Cost control (the hackathon budget rules)
-----------------------------------------
* `min_containers=0` - no idle GPU. The trade is a cold start (~2-5 min first time, ~40-90 s warm
  image) so the demo script must warm the endpoint before walking on stage.
* `scaledown_window` defaults to 5 minutes: long enough for a demo run, short enough to stop paying.
* `max_containers=1` - one replica. This is a fallback, not a load balancer; a second replica would
  double the GPU bill for a single-operator demo.
* The HF cache volume makes a cold start a disk read instead of a 22 GB download.

Honest limitations (measured nowhere yet - no Modal credentials on this machine)
-------------------------------------------------------------------------------
* Llama 3.2 Vision has **no OpenAI tool_calls support in vLLM**. The proxy therefore asks it for a
  JSON object and parses it (`PROXY_FALLBACK_TOOL_JSON`, default on). If the model answers in prose,
  the proxy declines to translate and the client's keyword fallback runs - by design.
* One image per prompt (`--limit-mm-per-prompt {"image": 1}`); batching several frames is not
  supported by mllama in vLLM.
* `--enforce-eager` is required for the mllama architecture (no CUDA-graph capture), so this route is
  slower than the primary even when the GPU is warm.
* This serves the **Spark** (chat/tool) role only. SAM 3.1 has no open-weight drop-in here; a
  segmentation fallback would be a different model and is out of scope.
"""

from __future__ import annotations

import json
import os
import subprocess

import modal

APP_NAME = "linecheck-fallback"
MODEL_NAME = os.environ.get("FALLBACK_MODEL", "meta-llama/Llama-3.2-11B-Vision-Instruct")
SERVED_MODEL_NAME = os.environ.get("FALLBACK_SERVED_MODEL_NAME", "llama-3.2-11b-vision")

# mllama needs a vLLM release that still carries the architecture. 0.8.x does; it was deprecated
# later, so the pin is deliberate - raising it silently can break the model load, not just a flag.
VLLM_VERSION = os.environ.get("FALLBACK_VLLM_VERSION", "0.8.5")
GPU = os.environ.get("FALLBACK_GPU", "L40S")  # 48 GB: 11B bf16 weights (22 GB) + KV cache headroom
VLLM_PORT = 8000
MINUTES = 60
HF_SECRET = os.environ.get("FALLBACK_SECRET_NAME", "linecheck-fallback")

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .entrypoint([])
    .uv_pip_install(f"vllm=={VLLM_VERSION}", "huggingface_hub[hf_transfer]")
    .env(
        {
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            # mllama + vLLM: the V1 multiprocessing path mis-handles the vision tower on some
            # drivers; spawn is the documented-safe default for this model family.
            "VLLM_WORKER_MULTIPROC_METHOD": "spawn",
        }
    )
)

hf_cache = modal.Volume.from_name("linecheck-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("linecheck-vllm-cache", create_if_missing=True)

app = modal.App(APP_NAME)


@app.function(
    image=vllm_image,
    gpu=GPU,
    volumes={
        "/root/.cache/huggingface": hf_cache,
        "/root/.cache/vllm": vllm_cache,
    },
    secrets=[modal.Secret.from_name(HF_SECRET)],
    timeout=10 * MINUTES,  # per-request ceiling; a vision call is seconds, not minutes
    scaledown_window=int(os.environ.get("FALLBACK_SCALEDOWN_SECONDS", str(5 * MINUTES))),
    min_containers=int(os.environ.get("FALLBACK_MIN_CONTAINERS", "0")),
    max_containers=1,
    # A single GPU sharing 4 in-flight requests is the useful ceiling for a demo: vLLM batches
    # internally, and queueing beats fanning out to a second paid replica.
)
@modal.concurrent(max_inputs=4)
@modal.web_server(port=VLLM_PORT, startup_timeout=15 * MINUTES)
def serve() -> None:
    """Start `vllm serve` and let it own the port. Modal waits for the socket to answer."""
    api_key = os.environ.get("FALLBACK_API_KEY")
    if not api_key:
        # Failing loudly beats serving an unauthenticated GPU endpoint that anyone can bill.
        raise RuntimeError(
            f"FALLBACK_API_KEY is not set in the Modal secret '{HF_SECRET}'. "
            "The proxy sends it as a bearer token; without it this endpoint is open to the internet."
        )
    if not os.environ.get("HF_TOKEN"):
        raise RuntimeError(
            f"HF_TOKEN is not set in the Modal secret '{HF_SECRET}'. "
            f"{MODEL_NAME} is a gated repository: the container cannot download the weights without it."
        )

    cmd = [
        "vllm", "serve", MODEL_NAME,
        "--served-model-name", SERVED_MODEL_NAME,
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--api-key", api_key,
        "--dtype", "bfloat16",
        "--max-model-len", "4096",
        "--max-num-seqs", "4",
        "--enforce-eager",
        "--limit-mm-per-prompt", json.dumps({"image": 1}),
    ]
    print("vllm command:", " ".join(cmd), flush=True)
    # stdout/stderr stay attached to the container log so a failed load is diagnosable
    # with `modal app logs linecheck-fallback` instead of guesswork.
    subprocess.Popen(cmd)
