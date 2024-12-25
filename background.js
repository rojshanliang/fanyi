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
        
        try {
            // 首先获取可用模型
            const availableModels = await this.getAvailableModels(apiKey);
            
            if (availableModels.length === 0) {
                return { isValid: false, models: [] };
            }

            // 使用第一个可用模型进行验证
            const testModel = availableModels[0].name.split('/').pop();
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: 'Hello'
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        topK: 1,
                        topP: 1
                    }
                })
            });

            const data = await response.json();
            console.log('API Key validation response:', data);

            return {
                isValid: response.ok,
                models: availableModels
            };
        } catch (error) {
            console.error('API Key validation error:', error);
            return { isValid: false, models: [] };
        }
    }
}

// 创建请求管理器实例
const requestManager = new RequestManager();

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('Received message in background:', request);
    
    if (request.action === "getApiKey") {
        chrome.storage.sync.get(['apiKey'], function(result) {
            sendResponse({ apiKey: result.apiKey });
        });
        return true;
    }

    if (request.action === "validateApiKey") {
        console.log('Validating API Key...');
        requestManager.validateApiKey(request.apiKey)
            .then(response => {
                console.log('Validation response:', response);
                sendResponse(response); // 直接发送完整的响应对象，包含 isValid 和 models
            })
            .catch(error => {
                console.error('API Key validation error:', error);
                sendResponse({ isValid: false, models: [] });
            });
        return true;
    }

    if (request.action === "translateText") {
        console.log('Processing translate text request');
        
        if (!request.apiKey) {
            console.log('No API Key provided');
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
                console.log('Translation response:', response);
                sendResponse(response);
            })
            .catch(error => {
                console.error('Translation error:', error);
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