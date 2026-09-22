#!/bin/bash

# Go to the directory where your .m4s files are located (replace '/path/to/your/files' with the actual path)
cd /path/to/your/files

# Find the smaller file (assuming it's the audio)
audio_file=$(ls -S *.m4s | tail -n 1)

# Find the larger file (assuming it's the video)
video_file=$(ls -S *.m4s | head -n 1)

# Use FFmpeg to merge the two .m4s files into an MP4 file
ffmpeg -i "$video_file" -i "$audio_file" -c:v copy -c:a aac -strict experimental output.mp4