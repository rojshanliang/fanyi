// popup.js

document.addEventListener('DOMContentLoaded', function() {
    const modelSelect = document.getElementById('modelSelect');
    const modelSelectGroup = document.getElementById('modelSelectGroup');
    
    // 获取已保存的设置
    chrome.storage.sync.get(['apiKey', 'targetLanguage', 'model'], function(result) {
        if (result.apiKey) {
            document.getElementById('apiKey').value = result.apiKey;
            modelSelectGroup.style.display = 'block';
            validateApiKeyAndUpdateModels(result.apiKey, result.model);
        } else {
            modelSelectGroup.style.display = 'none';
        }
        if (result.targetLanguage) {
            document.getElementById('targetLanguage').value = result.targetLanguage;
        }
    });

    // 添加模型选择变化事件监听
    modelSelect.addEventListener('change', function(e) {
        const selectedModel = e.target.value;
        console.log('Selected model:', selectedModel);
        // 自动保存选择的模型
        chrome.storage.sync.set({ model: selectedModel }, function() {
            console.log('Model selection saved:', selectedModel);
            showMessage('模型选择已保存', 'success');
        });
    });

    // API Key 输入框变化时更新模型列表
    document.getElementById('apiKey').addEventListener('input', function(e) {
        const apiKey = e.target.value.trim();
        if (apiKey) {
            modelSelectGroup.style.display = 'block';
            validateApiKeyAndUpdateModels(apiKey);
        } else {
            modelSelectGroup.style.display = 'none';
            modelSelect.innerHTML = '<option value="">请先输入有效的 API Key</option>';
            modelSelect.disabled = true;
        }
    });

    // 验证 API Key 并更新模型列表
    function validateApiKeyAndUpdateModels(apiKey, selectedModel = null) {
        chrome.runtime.sendMessage(
            { 
                action: "validateApiKey", 
                apiKey: apiKey
            }, 
            function(response) {
                console.log('Validation response:', response);
                if (response && response.isValid && response.models) {
                    modelSelect.innerHTML = '';
                    
                    response.models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.name.split('/').pop();
                        option.textContent = `${model.displayName} - ${model.description}`;
                        modelSelect.appendChild(option);
                    });

                    if (selectedModel && modelSelect.querySelector(`option[value="${selectedModel}"]`)) {
                        modelSelect.value = selectedModel;
                    } else if (modelSelect.options.length > 0) {
                        modelSelect.selectedIndex = 0;
                        // 如果没有之前选择的模型，保存第一个模型作为默认选择
                        chrome.storage.sync.set({ model: modelSelect.value });
                    }
                    
                    modelSelect.disabled = false;
                } else {
                    modelSelect.innerHTML = '<option value="">请先输入有效的 API Key</option>';
                    modelSelect.disabled = true;
                    modelSelectGroup.style.display = 'none';
                }
            }
        );
    }

    // 保存配置按钮点击事件
    document.getElementById('saveConfig').addEventListener('click', function() {
        const apiKey = document.getElementById('apiKey').value.trim();
        const targetLanguage = document.getElementById('targetLanguage').value;
        const model = modelSelect.value;

        if (!apiKey) {
            showMessage('请输入 API Key', 'error');
            return;
        }

        if (!model) {
            showMessage('请选择模型', 'error');
            return;
        }

        // 保存设置
        chrome.storage.sync.set({
            apiKey: apiKey,
            targetLanguage: targetLanguage,
            model: model
        }, function() {
            showMessage('配置已保存', 'success');
        });
    });
});

function showMessage(message, type) {
    const statusMessage = document.getElementById('statusMessage');
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    statusMessage.style.display = 'block';
    
    if (type === 'success') {
        setTimeout(() => {
            statusMessage.style.display = 'none';
        }, 2000);
    }
}