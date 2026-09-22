#!/bin/bash

# Check if FFmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "FFmpeg is not installed. Please install FFmpeg."
    exit 1
fi

# Loop through all MP3 files in the current folder and convert them to PCM
for file in *.mp3; do
    filename=$(basename "$file" .mp3)
    ffmpeg -i "$file" -f s16le -acodec pcm_s16le "${filename}.pcm"
    echo "Converted $file to ${filename}.pcm"
done

echo "Conversion of all MP3 files to PCM complete."