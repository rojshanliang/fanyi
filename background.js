// background.js

// 实现令牌桶限流器
class TokenBucket {
    constructor(capacity, fillPerSecond) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.fillPerSecond = fillPerSecond;
        this.lastFill = Date.now();
    }

    async getToken() {
        const now = Date.now();
        const timePassed = (now - this.lastFill) / 1000;
        this.tokens = Math.min(
            this.capacity,
            this.tokens + timePassed * this.fillPerSecond
        );
        this.lastFill = now;

        if (this.tokens < 1) {
            const waitTime = (1 - this.tokens) / this.fillPerSecond * 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.getToken();
        }

        this.tokens -= 1;
        return true;
    }
}

// 请求管理器
class RequestManager {
    constructor() {
        this.tokenBucket = new TokenBucket(5, 0.5); // 每2秒填充一个令牌，最多5个令牌
        this.retryDelays = [3000, 6000, 12000, 24000]; // 指数退避延迟
        this.requestQueue = [];
        this.isProcessing = false;
    }

    async addRequest(request) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ request, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.requestQueue.length > 0) {
            const { request, resolve, reject } = this.requestQueue[0];
            
            try {
                await this.tokenBucket.getToken();
                const result = await this.executeRequest(request);
                resolve(result);
                this.requestQueue.shift();
            } catch (error) {
                if (error.code === 429) {
                    // 如果是限流错误，等待后重试
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    continue;
                }
                reject(error);
                this.requestQueue.shift();
            }
        }

        this.isProcessing = false;
    }

    async executeRequest(request, retryCount = 0) {
        try {
            const response = await this.makeRequest(request);
            return response;
        } catch (error) {
            if (retryCount < this.retryDelays.length && this.shouldRetry(error)) {
                console.log(`Retrying request (${retryCount + 1}/${this.retryDelays.length})`);
                await new Promise(resolve => setTimeout(resolve, this.retryDelays[retryCount]));
                return this.executeRequest(request, retryCount + 1);
            }
            throw error;
        }
    }

    shouldRetry(error) {
        return error.code === 429 || error.code === 503 || error.message.includes('network');
    }

    async makeRequest(request) {
        const { text, targetLanguage, apiKey, model = 'gemini-pro' } = request;
        console.log('Making translation request...');

        if (!apiKey) {
            return { translatedText: '翻译请求失败: 请先在插件设置中配置有效的 API Key' };
        }

        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: `Translate the following text to ${targetLanguage}. Only return the translation without any explanation:\n${text}`
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        topK: 1,
                        topP: 1
                    },
                    safetySettings: [
                        {
                            category: "HARM_CATEGORY_HARASSMENT",
                            threshold: "BLOCK_NONE"
                        },
                        {
                            category: "HARM_CATEGORY_HATE_SPEECH",
                            threshold: "BLOCK_NONE"
                        },
                        {
                            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                            threshold: "BLOCK_NONE"
                        },
                        {
                            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                            threshold: "BLOCK_NONE"
                        }
                    ]
                })
            });

            const data = await response.json();
            console.log('API Response data:', data);

            if (!response.ok) {
                const errorMessage = data.error?.message || 'API request failed';
                throw new Error(errorMessage);
            }

            if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
                return { translatedText: data.candidates[0].content.parts[0].text };
            }

            throw new Error('Invalid API response format');
        } catch (error) {
            console.error('Translation error:', error);
            return { translatedText: `翻译请求失败: ${error.message}` };
        }
    }

    // 添加获取可用模型的方法
    async getAvailableModels(apiKey) {
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            const data = await response.json();
            console.log('Available models:', data);
            
            if (!response.ok) {
                throw new Error(data.error?.message || 'Failed to fetch models');
            }

            // 过滤出合适的模型
            const availableModels = data.models
                .filter(model => {
                    // 只选择 Gemini 系列模型
                    return model.name.toLowerCase().includes('gemini') &&
                           // 排除实验性和即将弃用的模型
                           !model.name.toLowerCase().includes('exp') &&
                           !model.description.toLowerCase().includes('experimental') &&
                           !model.description.toLowerCase().includes('deprecated');
                })
                .map(model => ({
                    name: model.name,
                    displayName: model.displayName,
                    description: model.description.split('.')[0] // 只取第一句描述
                }));

            // 按显示名称排序
            availableModels.sort((a, b) => a.displayName.localeCompare(b.displayName));
            
            return availableModels;
        } catch (error) {
            console.error('Error fetching models:', error);
            return [];
        }
    }

    // 修改 API Key 验证方法
    async validateApiKey(apiKey) {
        if (!apiKey) return { isValid: false, models: [] };
        
        console.log('API验证 >> 开始验证:', {
            操作时间: new Date().toLocaleTimeString(),
            状态: '验证中...'
        });

        try {
            const response = await this.getAvailableModels(apiKey);
            console.log('API验证 >> 获取可用模型:', {
                模型总数: response.length,
                操作时间: new Date().toLocaleTimeString(),
                状态: '✓ 成功'
            });

            // 验证响应并获取模型列表
            const validationResponse = await this.testModelAccess(apiKey);
            console.log('API验证 >> 模型访问测试:', {
                模型版本: validationResponse.modelVersion,
                Token统计: validationResponse.usageMetadata,
                操作时间: new Date().toLocaleTimeString(),
                状态: '✓ 成功'
            });

            // 过滤并处理模型列表
            const models = response
                .filter(model => model.name.includes('gemini'))
                .map(model => ({
                    name: model.name,
                    displayName: model.displayName,
                    description: model.description.split('.')[0]
                }));

            console.log('API验证 >> 验证完成:', {
                验证结果: '✓ 有效',
                可用模型数量: models.length,
                操作时间: new Date().toLocaleTimeString(),
                模型列表: models.map(m => m.displayName)
            });

            return { isValid: true, models };
        } catch (error) {
            console.error('API验证 >> 验证失败:', {
                错误信息: error.message,
                操作时间: new Date().toLocaleTimeString(),
                状态: '× 失败'
            });
            return { isValid: false, error: error.message };
        }
    }

    // 添加模型访问测试方法
    async testModelAccess(apiKey) {
        try {
            console.log('API验证 >> 开始测试模型访问:', {
                时间: new Date().toLocaleTimeString(),
                状态: '测试中...'
            });
            
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: 'Test'
                        }]
                    }]
                })
            });

            const data = await response.json();
            
            console.log('API验证 >> 模型访问测试结果:', {
                响应状态: response.ok ? '✓ 成功' : '× 失败',
                时间: new Date().toLocaleTimeString(),
                详细信息: data
            });

            return data;
        } catch (error) {
            console.error('API验证 >> 模型访问测试失败:', {
                错误信息: error.message,
                时间: new Date().toLocaleTimeString(),
                状态: '× 失败'
            });
            throw error;
        }
    }
}

// 创建请求管理器实例
const requestManager = new RequestManager();

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('后台消息 >> 接收到请求:', {
        请求类型: request.action,
        时间: new Date().toLocaleTimeString()
    });
    
    if (request.action === "getApiKey") {
        chrome.storage.sync.get(['apiKey', 'model'], function(result) {
            console.log('配置获取 >> 当前设置:', {
                API密钥: result.apiKey ? '已设置' : '未设置',
                当前模型: result.model || '未设置',
                获取时间: new Date().toLocaleTimeString()
            });
            sendResponse({ apiKey: result.apiKey, model: result.model });
        });
        return true;
    }

    if (request.action === "validateApiKey") {
        console.log('API验证 >> 开始验证请求:', {
            API密钥: request.apiKey ? '已提供' : '未提供',
            时间: new Date().toLocaleTimeString()
        });

        requestManager.validateApiKey(request.apiKey)
            .then(response => {
                console.log('API验证 >> 验证响应:', {
                    验证结果: response.isValid ? '✓ 有效' : '× 无效',
                    可用模型数: response.models?.length || 0,
                    可用模型: response.models?.map(m => m.displayName),
                    响应时间: new Date().toLocaleTimeString()
                });
                sendResponse(response);
            })
            .catch(error => {
                console.error('API验证 >> 验证错误:', {
                    错误信息: error.message,
                    发生时间: new Date().toLocaleTimeString(),
                    状态: '× 失败'
                });
                sendResponse({ isValid: false, models: [] });
            });
        return true;
    }

    if (request.action === "translateText") {
        console.log('翻译请求 >> 开始处理:', {
            目标语言: request.targetLanguage,
            使用模型: request.model,
            文本长度: request.text.length,
            请求时间: new Date().toLocaleTimeString()
        });
        
        if (!request.apiKey) {
            console.log('翻译请求 >> 验证失败:', {
                原因: '缺少 API Key',
                时间: new Date().toLocaleTimeString()
            });
            sendResponse({ 
                translatedText: '翻译请求失败: 缺少 API Key。\n' +
                               '请按以下步骤设置：\n' +
                               '1. 点击插件图标\n' +
                               '2. 选择"设置"\n' +
                               '3. 输入您的 API Key\n' +
                               '4. 保存并重试'
            });
            return true;
        }

        // 直接处理请求，不进行预验证
        requestManager.addRequest(request)
            .then(response => {
                console.log('翻译请求 >> 处理完成:', {
                    使用模型: request.model,
                    翻译状态: response.translatedText.includes('翻译请求失败') ? '× 失败' : '✓ 成功',
                    完成时间: new Date().toLocaleTimeString()
                });
                sendResponse(response);
            })
            .catch(error => {
                console.error('翻译请求 >> 发生错误:', {
                    使用模型: request.model,
                    错误类型: error.message.includes('authentication credentials') ? 'API认证错误' :
                             error.message.includes('network') ? '网络错误' :
                             error.code === 429 ? '请求频率限制' : '其他错误',
                    错误信息: error.message,
                    发生时间: new Date().toLocaleTimeString()
                });
                let errorMessage = '翻译请求失败: ';
                
                if (error.message.includes('authentication credentials')) {
                    errorMessage += 'API Key 无效或已过期。\n请检查并更新您的 API Key。';
                } else if (error.message.includes('network')) {
                    errorMessage += '网络连接错误。\n请检查网络连接并重试。';
                } else if (error.code === 429) {
                    errorMessage += '请求过于频繁。\n请稍后重试。';
                } else {
                    errorMessage += error.message;
                }
                
                sendResponse({ translatedText: errorMessage });
            });
        return true;
    }
});