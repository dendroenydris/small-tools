from ast import For
from fileinput import filename
import os
import requests


def parse(raw):
    if type(raw) == str:
        raise Exception(raw)
    if raw['IsErroredOnProcessing']:
        raise Exception(raw['ErrorMessage'][0])
    return raw['ParsedResults'][0]['ParsedText']


def ocr_space_file(filename, overlay=False, api_key='K85675861988957', language='eng'):
    """ OCR.space API request with local file.
        Python3.5 - not tested on 2.7
    :param filename: Your file path & name.
    :param overlay: Is OCR.space overlay required in your response.
                    Defaults to False.
    :param api_key: OCR.space API key.
                    Defaults to 'helloworld'.
    :param language: Language code to be used in OCR.
                    List of available language codes can be found on https://ocr.space/OCRAPI
                    Defaults to 'en'.
    :return: Result in JSON format.
    """

    payload = {'isOverlayRequired': overlay,
               'apikey': api_key,
               'language': language,
               }
    with open(filename, 'rb') as f:
        r = requests.post('https://api.ocr.space/parse/image',
                          files={filename: f},
                          data=payload,
                          )
    return parse(r.json())


def ocr_space_url(url, overlay=False, api_key='helloworld', language='eng'):
    """ OCR.space API request with remote file.
        Python3.5 - not tested on 2.7
    :param url: Image url.
    :param overlay: Is OCR.space overlay required in your response.
                    Defaults to False.
    :param api_key: OCR.space API key.
                    Defaults to 'helloworld'.
    :param language: Language code to be used in OCR.
                    List of available language codes can be found on https://ocr.space/OCRAPI
                    Defaults to 'en'.
    :return: Result in JSON format.
    """

    payload = {'url': url,
               'isOverlayRequired': overlay,
               'apikey': api_key,
               'language': language,
               }
    r = requests.post('https://api.ocr.space/parse/image',
                      data=payload,
                      )
    return parse(r.json())


dir="input"
files=os.listdir(dir)
files=[os.path.join(dir, path) for path in files]
# files = ["super-topic-1.pdf","super-topic-2.pdf","super-topic-3.pdf","super-topic-4.pdf"]
print(files)
for file in files:
    # Use examples:
    test_file = ocr_space_file(filename=file)

    with open(file+".txt", "w") as f:
        f.write(test_file)
        f.close()
        
    print("finish processing file: "+file)
