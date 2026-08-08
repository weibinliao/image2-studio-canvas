---
name: image2-studio-generate
description: Generate or edit images through a self-hosted Image2 Studio member service and return downloaded local image files. Use for text-to-image, one or more uploaded reference images, custom image size, quality, or output count without opening the webpage.
---

# Image2 Studio Generate

Generate images through the configured member service. Keep model and channel selection under Image2 Studio administrator control.

## Workflow

1. Read the prompt plus any requested size, quality, count, output directory, and uploaded image paths. Treat every image attached to the user's request as a reference automatically unless the user identifies a subset; do not ask the user to write file paths or `--input-image` flags.
2. Default to `1024x1024`, `low`, and one output when the user does not specify them. Use `high` when the user asks for high definition or maximum detail.
3. Run `scripts/generate-image.mjs` with an absolute script path. Pass each attached image path as a repeated `--input-image` argument in attachment order. Set the terminal execution timeout at least as high as `--timeout-seconds` and let the original process finish.
4. Read the final JSON object from stdout and render every returned `images[].path` with Markdown image syntax.
5. On success, return only the rendered image or images. Do not report the model, channel, elapsed time, URL, saved path, or other narration unless the user explicitly asks for it.

Use this command shape:

```powershell
node "<skill-root>\scripts\generate-image.mjs" --prompt "your prompt" --size 1024x1024 --quality low --n 1 --output-dir "<output-directory>"
```

For one output composed from multiple uploaded images, repeat `--input-image` and keep `--n 1`:

```powershell
node "<skill-root>\scripts\generate-image.mjs" --prompt "combine these references" --input-image "C:\images\person.png" --input-image "C:\images\scene.jpg" --size 1536x1024 --quality high --n 1 --output-dir "<output-directory>"
```

Optional arguments:

- `--base-url`: Image2 Studio URL. Defaults to `IMAGE2_STUDIO_URL`, then the URL packaged during installation, then `http://127.0.0.1:3020`.
- `--client-id`: Stable local client label. Defaults to `IMAGE2_STUDIO_CLIENT_ID`, then the previously persisted Skill ID. Member history and output access are authenticated by a signed session cookie that is reused only for the exact Image2 Studio origin. The Skill checks both `%LOCALAPPDATA%\Image2 Studio\codex-skill-client-id` and `~/.image2-studio/codex-skill-client-id` so compatible runtimes can share the same local state. If no state file is available, a deterministic host/user ID is persisted instead of generating a new random label.
- `--input-image`: Local PNG, JPEG, WEBP, or GIF path; an HTTP(S) image URL; or a base64 image data URL. Repeat it for up to 8 references. `--reference-image` is an alias.
- `--size`: Forward an image size such as `1024x1024`, `1536x1024`, or `1024x1536`.
- `--quality`: Forward `low`, `medium`, `high`, `auto`, or another value supported by the configured provider.
- `--n`: Generate 1-8 images. Defaults to 1.
- `--output-dir`: Download directory. Defaults to `IMAGE2_STUDIO_OUTPUT_DIR`, then the system temporary directory.
- `--timeout-seconds`: Maximum job wait. Defaults to 900 seconds.

## Guardrails

- Always use the bundled script. It sends `X-Image2-Role: member` and verifies `admin=false` before generation.
- Keep using the same exact Image2 Studio origin to preserve the signed member session. `localhost`, a LAN address, and a reverse-proxy address are separate origins and intentionally do not share session cookies.
- Do not copy a persisted session cookie or state file between origins. A new origin receives a new member session after its first successful connection.
- Set `IMAGE2_STUDIO_IDENTITY_SCOPE` when several isolated Codex runtimes intentionally share one Windows account and should use a specific stable identity scope.
- Keep the persisted state private. It contains the signed member session that separates Skill history and output access between member computers.
- Do not ask for an API key. The Image2 Studio server owns channel credentials.
- Do not send a model override. The administrator-configured member model is authoritative.
- Do not silently switch to another image-generation service when Image2 Studio fails. Return the server error and the URL used.
- Do not delete the server-side history or generated image after downloading it.
- Use a LAN `--base-url` when Codex runs on a member computer. The default localhost URL is for the Image2 Studio host.
- Do not submit a duplicate job after a short terminal-wrapper timeout. Continue waiting for the original process when possible.
- Do not query history, audit logs, or channel metadata after a successful script result.
