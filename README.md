# Pi Voice

Voice dictation for Pi, transcribed by a remote OpenAI-compatible API.

Press a keyboard shortcut, talk, and the resulting transcript will be put directly into your chat.

> **Fork notice** — This project is a fork of
> [earendil-works/pi-voice](https://github.com/earendil-works/pi-voice) by
> Earendil Works contributors (MIT). The original runs speech recognition
> with local models; this fork replaces them with a remote,
> OpenAI-compatible transcription API. The upstream project did the heavy
> lifting — microphone capture, dictation flow, settings UI, and tests — and
> this fork builds on that work with gratitude.

## Install

Install the npm package:

```bash
pi install npm:@tinyplan/pi-voice
```

If you prefer being on the development tip, you can install from GitHub:

```bash
pi install ssh://git@github.com/tinyplan/pi-voice
```

## Setup

Pi Voice sends each recording to an OpenAI-compatible audio transcription
endpoint (`POST /v1/audio/transcriptions`, multipart with a 16 kHz mono WAV).
Configure it with environment variables before starting Pi:

```bash
# The API key sent as a bearer token. Required for OpenAI's endpoint;
# OPENAI_API_KEY is the fallback. A custom endpoint (below) may omit it.
export PI_VOICE_ASR_API_KEY=sk-...

# Optional: OpenAI's endpoint is the default. Point this at Groq, Azure OpenAI,
# or your own llama.cpp / whisper.cpp server that speaks the same protocol.
# No Authorization header is sent when no key is set.
export PI_VOICE_ASR_BASE_URL=http://127.0.0.1:8080/v1

# Optional: seconds of audio per request for long recordings (default 600,
# clamped to 10–3600). Lower it for local LLM-based models with a smaller
# audio context window, e.g. 180 for qwen3-asr.
export PI_VOICE_ASR_MAX_SECONDS=180
```

The key is read from the environment at every request; it is never written to
Pi Voice's settings file.

### Local llama.cpp with Qwen3-ASR (verified)

A local `llama-server` running a Qwen3-ASR GGUF works out of the box. It
exposes `/v1/audio/transcriptions`; Pi Voice strips the model's
`language …<asr_text>` template prefix and treats its instruction echo on
silence as no speech:

```bash
export PI_VOICE_ASR_BASE_URL=http://127.0.0.1:8080/v1   # no key needed
export PI_VOICE_ASR_MAX_SECONDS=180                     # smaller audio context
# /voice-settings → Model → Custom model name… → e.g. Qwen3-ASR-1.7B
```

The `language` setting is ignored by this server: the model detects the
language itself. Chinese output still follows the Chinese-output setting.

The transcription model (default `whisper-1`), your languages, microphone, and
shortcut are configured in `/voice-settings`.

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Space` by default) to start and stop recording;
- `/voice`, which does the same as the shortcut. While recording, `Space` also stops and transcribes, and `Escape` discards;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice-settings` for preferred languages, model, transcription language, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`.

Audio is uploaded to the configured endpoint, so it leaves your machine —
choose your provider accordingly.

## Upgrading from upstream Pi Voice 0.2 (local models)

Upstream Pi Voice 0.2 ran transcription models locally after downloading
them. This fork removes the local models entirely in favor of the remote API
above; recordings are no longer transcribed offline. Your languages,
microphone, shortcut, and Chinese output settings carry over; set an API key
and pick a model with `/voice-settings`. To remove the old downloads, clear
the Pi Voice entries from your Hugging Face cache
(`~/.cache/huggingface/hub`).

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Decoded
audio is limited to 512 MiB (about 2.3 hours); longer files are sent as
sequential requests. File decoding requires the `ffmpeg` executable. Install
FFmpeg with your system package manager if you don't already have it installed

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point Pi Voice at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set.

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command.

## Developing & Building Pi Voice

To develop or run it from a checkout:

```bash
git clone git@github.com:tinyplan/pi-voice.git
cd pi-voice
npm install --ignore-scripts
pi -e .
```

If you want to be able to re-run onboarding you can enable the debug env var when starting Pi. This enables the `/voice-onboarding` command.

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```
