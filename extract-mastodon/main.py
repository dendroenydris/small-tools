import json

output = ""
with open("outbox.json", "r") as f:
    dic = json.loads(f.read())
    content = dic["orderedItems"]
    for item in content:
        obj = item.get("object")
        if isinstance(obj, dict):
            content = str(obj["content"]
                          )[3:-4].replace("<p>", "").replace("</p>", "").replace("<br />", "\n")
            if "summary" in obj and obj["summary"] != None:
                content = str(obj["summary"]) + "\n<fold>"+content+"\n</fold>"
            content = str(obj["published"])[:10]+"\n" + content
            output += content+"\n\n"
    f.close()

with open("output.txt", "w") as f:
    f.write(output)
    f.close()
