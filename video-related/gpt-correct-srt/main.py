import openai
from tqdm import tqdm
client = openai.OpenAI()
# Function to chunk the file content
filename='1.txt'

def chunk_file_content(lines, chunk_size=20):
    for i in range(0, len(lines), chunk_size):
        yield lines[i:i + chunk_size]

# Function to correct text using OpenAI's completion API


def correct_text_with_gpt(text, prompt):
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "user", "content": f"{prompt}{text}"}
        ]
    )
    return response.choices[0].message.content

# Read the file
with open(filename, 'r') as file:
    lines = file.readlines()

# Prompt definition
prompt = "make minimal changes to translate this Portuguese audio transcript to chinese and keep the format as srt, do not change any number: \n"
# prompt = "make minimal changes to correct this korean audio transcript and keep the format as srt:\n"

output = ""
# Iterate over the chunks of the file
pbar = tqdm(total=len(lines)/20)
for chunk_number, chunk_lines in enumerate(chunk_file_content(lines)):
    pbar.update(1)
    chunk_text = "".join(chunk_lines)
    output += correct_text_with_gpt(chunk_text, prompt)+"\n\n"


# Output or save the corrected text
with open(filename[:-4]+"-output.srt", 'w') as out_file:
    out_file.write(output)

print(f'file corrected and saved.')
