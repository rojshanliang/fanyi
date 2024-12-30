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
        this.quotaLimit = 60; // 每分钟请求限制
        this.quotaUsed = 0;
        this.quotaResetTime = Date.now() + 60000;
        
        // 重置配额计数器
        setInterval(() => {
            this.quotaUsed = 0;
            this.quotaResetTime = Date.now() + 60000;
        }, 60000);
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
        const { text, targetLang, apiKey, model = 'gemini-pro' } = request;
        console.log('Making translation request...');

        if (!apiKey) {
            console.error('Translation error: No API Key provided');
            return { translatedText: '翻译请求失败: 请先在插件设置中配置有效的 API Key' };
        }

        if (this.quotaUsed >= this.quotaLimit) {
            const waitTime = this.quotaResetTime - Date.now();
            if (waitTime > 0) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
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
                            text: `Translate the following text to ${targetLang}. Only return the translation without any explanation:\n${text}`
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

            if (!response.ok) {
                const errorData = await response.json();
                console.error('API Response error:', errorData);
                throw new Error(errorData.error?.message || 'API request failed');
            }

            const data = await response.json();
            console.log('API Response data:', data);

            if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
                this.quotaUsed++;
                return { translatedText: data.candidates[0].content.parts[0].text.trim() };
            }

            throw new Error('Invalid API response format');
        } catch (error) {
            console.error('Translation error:', error);
            if (error.message.includes('Resource has been exhausted')) {
                // 等待一分钟后重试
                await new Promise(resolve => setTimeout(resolve, 60000));
                return this.makeRequest(apiKey, text, targetLang);
            }
            return { translatedText: `翻译请求失败: ${error.message}` };
        }
    }

    // 添加获取可用模型的方法
    async getAvailableModels(apiKey) {
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            const data = await response.json();
            
            if (!response.ok) {
                // 处理区域限制错误
                if (data.error?.message?.includes('User location is not supported')) {
                    // 返回默认的 Gemini Pro 模型
                    return [{
                        name: 'gemini-pro',
                        displayName: 'Gemini Pro',
                        description: 'Gemini Pro model for text generation and translation'
                    }];
                }
                throw new Error(data.error?.message || 'Failed to fetch models');
            }

            // 过滤出合适的模型
            const availableModels = data.models
                .filter(model => {
                    return model.name.toLowerCase().includes('gemini') &&
                           !model.name.toLowerCase().includes('exp') &&
                           !model.description.toLowerCase().includes('experimental') &&
                           !model.description.toLowerCase().includes('deprecated');
                })
                .map(model => ({
                    name: model.name,
                    displayName: model.displayName,
                    description: model.description.split('.')[0]
                }));

            return availableModels.length > 0 ? availableModels : [{
                name: 'gemini-pro',
                displayName: 'Gemini Pro',
                description: 'Gemini Pro model for text generation and translation'
            }];
        } catch (error) {
            console.error('Error fetching models:', error);
            // 发生错误时返回默认模型
            return [{
                name: 'gemini-pro',
                displayName: 'Gemini Pro',
                description: 'Gemini Pro model for text generation and translation'
            }];
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
            // 获取可用模型列表
            const models = await this.getAvailableModels(apiKey);
            
            // 测试模型访问
            try {
                await this.testModelAccess(apiKey);
                console.log('API验证 >> 验证完成:', {
                    验证结果: '✓ 有效',
                    可用模型数量: models.length,
                    操作时间: new Date().toLocaleTimeString(),
                    模型列表: models.map(m => m.displayName)
                });

                return { 
                    isValid: true, 
                    models,
                    error: null
                };
            } catch (error) {
                // 如果是区域限制错误，仍然返回有效，但使用默认模型
                if (error.message?.includes('User location is not supported')) {
                    console.log('API验证 >> 区域限制，使用默认模型');
                    return {
                        isValid: true,
                        models: [{
                            name: 'gemini-pro',
                            displayName: 'Gemini Pro',
                            description: 'Gemini Pro model for text generation and translation'
                        }],
                        error: 'User location is not supported, using default model'
                    };
                }
                throw error;
            }
        } catch (error) {
            console.error('API验证 >> 验证失败:', {
                错误信息: error.message,
                操作时间: new Date().toLocaleTimeString(),
                状态: '× 失败'
            });
            
            // 如果是区域限制错误，仍然返回有效，但使用默认模型
            if (error.message?.includes('User location is not supported')) {
                return {
                    isValid: true,
                    models: [{
                        name: 'gemini-pro',
                        displayName: 'Gemini Pro',
                        description: 'Gemini Pro model for text generation and translation'
                    }],
                    error: 'User location is not supported, using default model'
                };
            }
            
            return { isValid: false, error: error.message };
        }
    }

    // 修改 testModelAccess 方法
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
            
            if (!response.ok) {
                throw new Error(data.error?.message || 'API request failed');
            }

            console.log('API验证 >> 模型访问测试结果:', {
                响应状态: '✓ 成功',
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

// 建请求管理器实例
const requestManager = new RequestManager();

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 添加调试日志
    console.log('后台消息 >> 接收到完整请求:', request);
    console.log('后台消息 >> 接收到请求:', {
        请求类型: request.type,
        时间: new Date().toLocaleTimeString(),
        详细信息: JSON.stringify(request)
    });

    if (request.type === 'getApiKey') {
        console.log('API Key获取 >> 开始获取');
        chrome.storage.sync.get('apiKey', (data) => {
            if (chrome.runtime.lastError) {
                console.error('API Key获取 >> 错误:', {
                    错误信息: chrome.runtime.lastError,
                    时间: new Date().toLocaleTimeString()
                });
                sendResponse({ error: 'Failed to retrieve API Key' });
            } else {
                console.log('API Key获取 >> 成功:', {
                    状态: data.apiKey ? '✓ 已获取' : '× 未设置',
                    时间: new Date().toLocaleTimeString()
                });
                sendResponse({ apiKey: data.apiKey });
            }
        });
        return true; // 保持消息通道开启
    }

    if (request.type === 'validateApiKey') {
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
                sendResponse({ isValid: false, models: [], error: error.message });
            });
        return true;
    }

    if (request.type === 'translateText') {
        console.log('翻译请求 >> 开始处理:', {
            目标语言: request.targetLang,
            文本长度: request.text.length,
            请求时间: new Date().toLocaleTimeString()
        });

        // 先获取 API Key
        chrome.storage.sync.get('apiKey', async (data) => {
            try {
                if (!data.apiKey) {
                    console.error('翻译请求 >> 错误: API Key未设置');
                    sendResponse({ translatedText: '翻译请求失败: 请先在插件设置中配置有效的 API Key' });
                    return;
                }

                // 将 API Key 添加到请求中
                const translationRequest = {
                    ...request,
                    apiKey: data.apiKey
                };

                console.log('翻译请求 >> API Key获取成功，开始翻译');
                const response = await requestManager.addRequest(translationRequest);
                console.log('翻译请求 >> 翻译完成:', response);
                sendResponse({ translatedText: response.translatedText || '' });
            } catch (error) {
                console.error('翻译请求 >> 错误:', error);
                sendResponse({ translatedText: `翻译请求失败: ${error.message}` });
            }
        });
        return true; // Keep the message channel open for async response
    }
});