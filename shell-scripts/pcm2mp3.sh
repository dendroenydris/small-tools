#!/bin/bash

# Check if FFmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "FFmpeg is not installed. Please install FFmpeg."
    exit 1
fi

# Loop through all PCM files in the current folder and convert them to MP3
for file in *.pcm; do
    filename=$(basename "$file" .pcm)
    ffmpeg -f s16le -ar 44100 -ac 2 -i "$file" "${filename}.mp3"
    echo "Converted $file to ${filename}.mp3"
done

echo "Conversion of all PCM files to MP3 complete."