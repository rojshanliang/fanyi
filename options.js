// options.js

document.getElementById("save-button").addEventListener("click", () => {
    const defaultLanguage = document.getElementById("default-language").value;
    chrome.storage.sync.set({ defaultLanguage }, () => {
        console.log("默认语言已保存:", defaultLanguage);
    });
});