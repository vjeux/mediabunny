Fixtures of `test/browser/codec-bitstream-differential.test.ts`, made with FFmpeg 8.0 (libx264, libvpx, libaom, libfdk_aac,
libopus, libvorbis, libmp3lame):

- `h264-high10.mp4`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p10le -frames:v 6 -c:v libx264 -preset fast -profile:v high10 h264-high10.mp4`
- `h264-high422.mp4`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv422p -frames:v 6 -c:v libx264 -preset fast -profile:v high422 h264-high422.mp4`
- `h264-high444.mp4`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv444p -frames:v 6 -c:v libx264 -preset fast -profile:v high444 h264-high444.mp4`
- `h264-34x18.mp4`: `ffmpeg -f lavfi -i testsrc2=s=34x18:r=25,format=yuv420p -frames:v 6 -c:v libx264 -preset fast h264-34x18.mp4`
- `h264-sar-16-11.mp4`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p -frames:v 6 -c:v libx264 -preset fast -vf setsar=16/11 h264-sar-16-11.mp4`
- `h264-bt709-full.mp4`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p -frames:v 6 -c:v libx264 -preset fast -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=pc -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range pc h264-bt709-full.mp4`
- `vp8.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p -frames:v 6 -c:v libvpx -deadline realtime -cpu-used 8 vp8.webm`
- `vp9-profile1-422.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv422p -frames:v 6 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -lag-in-frames 0 vp9-profile1-422.webm`
- `vp9-profile1-444.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv444p -frames:v 6 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -lag-in-frames 0 vp9-profile1-444.webm`
- `vp9-profile2-10bit.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p10le -frames:v 6 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -lag-in-frames 0 vp9-profile2-10bit.webm`
- `vp9-profile3-444-12bit.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv444p12le -frames:v 6 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -lag-in-frames 0 vp9-profile3-444-12bit.webm`
- `vp9-bt2020-pq.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p10le -frames:v 6 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -lag-in-frames 0 -vf setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc vp9-bt2020-pq.webm`
- `av1-main-10bit.mp4`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p10le -frames:v 6 -c:v libaom-av1 -cpu-used 8 -row-mt 1 -lag-in-frames 0 av1-main-10bit.mp4`
- `av1-high-444.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv444p -frames:v 6 -c:v libaom-av1 -cpu-used 8 -row-mt 1 -lag-in-frames 0 av1-high-444.webm`
- `av1-professional-422-10bit.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv422p10le -frames:v 6 -c:v libaom-av1 -cpu-used 8 -row-mt 1 -lag-in-frames 0 av1-professional-422-10bit.webm`
- `av1-bt709-full.mp4`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=yuv420p -frames:v 6 -c:v libaom-av1 -cpu-used 8 -row-mt 1 -lag-in-frames 0 -vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=pc -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range pc av1-bt709-full.mp4`
- `av1-monochrome.webm`: `ffmpeg -f lavfi -i testsrc2=s=64x48:r=25,format=gray -frames:v 6 -c:v libaom-av1 -cpu-used 8 -row-mt 1 -lag-in-frames 0 av1-monochrome.webm`
- `aac-he.mp4`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t):s=48000:d=0.25:c=stereo' -c:a libfdk_aac -profile:a aac_he aac-he.mp4`
- `aac-he-v2.mp4`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t):s=48000:d=0.25:c=stereo' -c:a libfdk_aac -profile:a aac_he_v2 aac-he-v2.mp4`
- `aac-lc-6.1.mp4`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t)|0.3*sin(440*2*PI*t)|0.3*sin(550*2*PI*t)|0.3*sin(660*2*PI*t)|0.3*sin(770*2*PI*t)|0.3*sin(880*2*PI*t):s=48000:d=0.1:c=6.1' -c:a aac -b:a 128k aac-lc-6.1.mp4`
- `opus-5.1.webm`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t)|0.3*sin(440*2*PI*t)|0.3*sin(550*2*PI*t)|0.3*sin(660*2*PI*t)|0.3*sin(770*2*PI*t):s=48000:d=0.1:c=5.1' -c:a libopus opus-5.1.webm`
- `opus-family255-quad.webm`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t)|0.3*sin(440*2*PI*t)|0.3*sin(550*2*PI*t):s=48000:d=0.1:c=quad' -c:a libopus -mapping_family 255 opus-family255-quad.webm`
- `vorbis.webm`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t):s=44100:d=0.1:c=stereo' -c:a libvorbis vorbis.webm`
- `flac-5.1-24bit.mkv`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t)|0.3*sin(440*2*PI*t)|0.3*sin(550*2*PI*t)|0.3*sin(660*2*PI*t)|0.3*sin(770*2*PI*t):s=48000:d=0.05:c=5.1' -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 flac-5.1-24bit.mkv`
- `mp3.mp3`: `ffmpeg -f lavfi -i 'aevalsrc=exprs=0.3*sin(220*2*PI*t)|0.3*sin(330*2*PI*t):s=44100:d=0.1:c=stereo' -c:a libmp3lame mp3.mp3`
