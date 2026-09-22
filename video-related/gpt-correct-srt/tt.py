import re

# Regular expression to find numbers ending with '6' that are incorrectly followed by text
pattern = re.compile(r'(?<!\n:)\d+[6][\n]')

# Function to correct the SRT content
def correct_srt_content(srt_content):
    print(pattern.findall(srt_content))
    # Insert a newline between the number ending with '6' and the following text
    corrected_content = pattern.sub(r'\n\n\g<0>', srt_content)
    return corrected_content

# Read the SRT file
with open('111222.srt', 'r', encoding='utf-8') as file:
    srt_data = file.read()

# Correct the SRT content
corrected_srt_data = correct_srt_content(srt_data)

# Write the corrected SRT content to a new file
with open('corrected_subtitle.srt', 'w', encoding='utf-8') as file:
    file.write(corrected_srt_data)

print("Subtitles have been corrected and saved to 'corrected_subtitle.srt'.")