---
description: MP3 (MPEG-1/2 Audio Layer III) audio codec definition, defining legal codec strings, decoder configs, and packet data formats.
---

<script setup>
import { VPBadge } from 'vitepress/theme'
</script>

<VPBadge type="info" text="Audio codec" />

# MP3 codec registration

## Description

The MP3 audio codec (MPEG-1/2 Audio Layer III), specified in [ISO/IEC 13818-3](https://www.iso.org/standard/26797.html).

## Codec ID

```ts
'mp3'
```

## `EncodedPacket` data

The packet's data must be an MP3 frame as described in Section 2.4.2.2 of [ISO/IEC 13818-3](https://www.iso.org/standard/26797.html).

## `EncodedPacket` type

The packet's type is always `'key'`.

## `AudioDecoderConfig` codec string

This codec has multiple equivalent codec strings:

- `'mp3'`
- `'mp4a.69'`
- `'mp4a.6B'`

## `AudioDecoderConfig` description

`description` is not used for this codec.
