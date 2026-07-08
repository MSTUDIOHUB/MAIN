const text = "here is some text <think>and here is a thought";
const lower = text.toLowerCase();
const tags = ["think"];
let result = "";
let i = 0;
while (i < text.length) {
    let openIdx = text.indexOf("<think");
    result += text.slice(i, openIdx);
    break;
}
console.log(result);
