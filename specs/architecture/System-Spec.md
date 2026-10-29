# System Architecture Spec — LineCheck Vision

## Hardware / Target Specs
- HUD Resolution: 600x600 px (fixed aspect canvas)
- Streaming: Local WebMCP IPC socket

## Pipeline Flow
1. **Audio Capture & Intent:** Local audio stream -> Muse Voice Transcribe -> Muse Spark 1.3 parser.
2. **Visual Segmentation:** Camera buffer -> SAM 3.1 canvas overlay.
3. **Execution Boundary:** Hackathon public demo UI is decoupled from core private repositories.
