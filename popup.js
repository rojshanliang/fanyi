// popup.js

document.addEventListener('DOMContentLoaded', function() {
    const modelSelect = document.getElementById('modelSelect');
    const modelSelectGroup = document.getElementById('modelSelectGroup');
    const testButton = document.getElementById('testApiKey');
    const apiKeyInput = document.getElementById('apiKey');
    let lastValidApiKey = ''; // 记录上次有效的API Key
    let lastSelectedModel = ''; // 记录上次选择的模型
    
    // 获取已保存的设置
    chrome.storage.sync.get(['apiKey', 'targetLanguage', 'model'], function(result) {
        console.log('Initial settings loaded:', {
            hasApiKey: !!result.apiKey,
            targetLanguage: result.targetLanguage,
            currentModel: result.model
        });

        if (result.apiKey) {
            apiKeyInput.value = result.apiKey;
            lastValidApiKey = result.apiKey;
            modelSelectGroup.style.display = 'block';
            
            // 如果有已保存的模型，直接显示
            if (result.model) {
                lastSelectedModel = result.model;
                modelSelect.innerHTML = '';
                const option = document.createElement('option');
                option.value = result.model;
                option.textContent = result.model;
                modelSelect.appendChild(option);
                modelSelect.value = result.model;
                modelSelect.disabled = false;
            }
        }

        if (result.targetLanguage) {
            document.getElementById('targetLanguage').value = result.targetLanguage;
        }
    });

    // API Key 输入框变化事件
    apiKeyInput.addEventListener('input', function(e) {
        const apiKey = e.target.value.trim();
        if (!apiKey) {
            modelSelectGroup.style.display = 'none';
            modelSelect.innerHTML = '<option value="">请先输入有效的 API Key</option>';
            modelSelect.disabled = true;
        }
    });

    // API Key 测试按钮点击事件
    testButton.addEventListener('click', function() {
        const apiKey = apiKeyInput.value.trim();
        if (apiKey) {
            console.log('用户操作 >> 开始测试 API Key:', {
                时间: new Date().toLocaleTimeString()
            });
            testButton.disabled = true;
            testButton.textContent = '测试中...';
            
            validateApiKeyAndUpdateModels(apiKey, false);
        } else {
            showMessage('请输入 API Key', 'error');
            modelSelectGroup.style.display = 'none';
            modelSelect.innerHTML = '<option value="">请先输入有效的 API Key</option>';
            modelSelect.disabled = true;
        }
    });

    // 验证 API Key 并更新模型列表
    function validateApiKeyAndUpdateModels(apiKey, isSilent = false) {
        chrome.runtime.sendMessage(
            { 
                type: "validateApiKey", 
                apiKey: apiKey
            }, 
            function(response) {
                testButton.disabled = false;
                
                if (response && response.isValid && response.models) {
                    if (!isSilent) {
                        testButton.textContent = '测试通过';
                        testButton.className = 'test-button success';
                        showMessage('API Key 验证成功', 'success');
                    } else {
                        testButton.textContent = '测试密钥';
                    }
                    
                    lastValidApiKey = apiKey;
                    modelSelectGroup.style.display = 'block';
                    
                    // 保存当前选择的值
                    const currentValue = modelSelect.value;
                    
                    modelSelect.innerHTML = '';
                    const defaultOption = document.createElement('option');
                    defaultOption.value = '';
                    defaultOption.textContent = '请选择模型';
                    modelSelect.appendChild(defaultOption);
                    
                    response.models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.name.split('/').pop();
                        option.textContent = `${model.displayName}`;
                        modelSelect.appendChild(option);
                    });

                    // 恢复之前的选择
                    if (lastSelectedModel && !isSilent) {
                        modelSelect.value = lastSelectedModel;
                    }
                    modelSelect.disabled = false;
                } else {
                    if (!isSilent) {
                        testButton.textContent = '测试失败';
                        testButton.className = 'test-button error';
                        showMessage('API Key 验证失败', 'error');
                    } else {
                        testButton.textContent = '测试密钥';
                    }
                    modelSelect.innerHTML = '<option value="">请先输入有效的 API Key</option>';
                    modelSelect.disabled = true;
                    modelSelectGroup.style.display = 'none';
                }
            }
        );
    }

    // 模型选择变化事件
    modelSelect.addEventListener('change', function(e) {
        const selectedModel = e.target.value;
        if (selectedModel) {
            lastSelectedModel = selectedModel;
            console.log('用户操作 >> 选择模型:', {
                选择的模型: selectedModel,
                模型名称: e.target.options[e.target.selectedIndex].textContent,
                操作时间: new Date().toLocaleTimeString()
            });
        }
    });

    // 保存配置按钮点击事件
    document.getElementById('saveConfig').addEventListener('click', function() {
        const apiKey = apiKeyInput.value.trim();
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
            console.log('配置保存 >> 所有设置已保存:', {
                目标语言: targetLanguage,
                当前模型: model,
                保存时间: new Date().toLocaleTimeString(),
                状态: '✓ 保存成功'
            });
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

// 测试 API Key
async function testApiKey(apiKey) {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'validateApiKey',  // 确保设置正确的消息类型
            apiKey: apiKey
        });
        
        if (!response || typeof response !== 'object') {
            throw new Error('Invalid response from background script');
        }
        
        return response;
    } catch (error) {
        console.error('API Key validation error:', error);
        throw error;
    }
}

// 保存 API Key
async function saveApiKey(apiKey) {
    try {
        await chrome.storage.sync.set({ apiKey });
        const response = await testApiKey(apiKey);
        return response;
    } catch (error) {
        console.error('Error saving API Key:', error);
        throw error;
    }
}

// 在验证 API Key 成功后添加模型选择逻辑
async function validateAndSaveApiKey() {
    const apiKey = document.getElementById('apiKey').value;
    const response = await chrome.runtime.sendMessage({
        type: 'validateApiKey',
        apiKey: apiKey
    });
    
    const modelSelect = document.getElementById('modelSelect');
    modelSelect.innerHTML = ''; // 清空现有选项
    
    if (response.isValid) {
        // 保存 API Key
        await chrome.storage.sync.set({ apiKey });
        
        // 更新模型选择下拉框
        if (response.models && response.models.length > 0) {
            response.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.name;
                option.textContent = `${model.displayName}`;
                modelSelect.appendChild(option);
            });
            modelSelect.disabled = false;
            
            // 默认选择第一个模型
            modelSelect.value = response.models[0].name;
            
            // 保存默认模型
            chrome.storage.sync.set({ 
                model: response.models[0].name 
            });

            // 显示成功消息
            showMessage(
                response.error 
                    ? 'API Key 验证成功 (区域限制使用默认模型)' 
                    : 'API Key 验证成功', 
                'success'
            );
        }
    } else {
        modelSelect.innerHTML = '<option value="">请先输入有效的 API Key</option>';
        modelSelect.disabled = true;
        showMessage('API Key 验证失败: ' + (response.error || '未知错误'), 'error');
    }
}