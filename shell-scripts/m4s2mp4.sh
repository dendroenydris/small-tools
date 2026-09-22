#!/bin/bash

# Check if FFmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "FFmpeg is not installed. Please install FFmpeg."
    exit 1
fi

# Loop through all MP3 files in the current folder and convert them to PCM
for file in *.m4s; do
    filename=$(basename "$file" .mp3)
    ffmpeg -i "$file" -c copy "${filename}.mp4"
    echo "Converted $file to ${filename}.mp4"
done

echo "Conversion of all M4s files to mp4 complete."