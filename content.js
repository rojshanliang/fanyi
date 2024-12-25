// content.js
console.log('Content script loaded');

// 使用立即执行函数来避免变量污染
(function() {
    const originalTexts = new Map();
    let isTranslating = false;
    let lastTranslatedHeight = 0;
    let translateButton = null;
    let apiKey = null;

    // 修改全局请求限制器
    const requestLimiter = {
        queue: [],
        isProcessing: false,
        minInterval: 800,       // 减少请求间隔到800ms
        lastRequestTime: 0,
        maxRetries: 3,          // 设置合理的重试次数
        retryDelay: 2000,       // 减少初始重试延迟
        maxBackoff: 30000,      // 增加最大退避时间
        maxConcurrent: 8,        // 增加并发数到8
        currentConcurrent: 0,
        maxSegmentLength: 1000,  // 增加单个段落的最大长度
        minSegmentLength: 50,    // 减少最小段落长度
        batchSize: 8,           // 增加批处理大小

        // 新增：智能文本分段方法
        splitTextIntoSegments(text) {
            const segments = [];
            const paragraphs = text.split(/\n\s*\n/);
            
            paragraphs.forEach(paragraph => {
                if (paragraph.length <= this.maxSegmentLength) {
                    segments.push(paragraph);
                } else {
                    // 按句子分割
                    const sentences = paragraph.split(/([.!?。！？]+\s+)/);
                    let currentSegment = '';
                    
                    sentences.forEach(sentence => {
                        if (!sentence.trim()) return;
                        
                        if (currentSegment.length + sentence.length <= this.maxSegmentLength) {
                            currentSegment += sentence;
                        } else {
                            if (currentSegment.length >= this.minSegmentLength) {
                                segments.push(currentSegment.trim());
                                currentSegment = sentence;
                            } else {
                                // 如果当前段太短，尝试按逗号分割
                                const parts = sentence.split(/([,，;；]+\s*)/);
                                parts.forEach(part => {
                                    if (currentSegment.length + part.length <= this.maxSegmentLength) {
                                        currentSegment += part;
                                    } else {
                                        if (currentSegment.length >= this.minSegmentLength) {
                                            segments.push(currentSegment.trim());
                                            currentSegment = part;
                                        } else {
                                            currentSegment += part;
                                        }
                                    }
                                });
                            }
                        }
                    });
                    
                    if (currentSegment.length >= this.minSegmentLength) {
                        segments.push(currentSegment.trim());
                    }
                }
            });
            
            return segments;
        },

        // 修改分批处理方法
        splitIntoBatches(nodes, maxSize) {
            const batches = [];
            let currentBatch = [];
            let currentBatchLength = 0;
            
            nodes.forEach(node => {
                const text = node.textContent.trim();
                if (!text) return;

                if (text.length > this.maxSegmentLength) {
                    const segments = this.splitTextIntoSegments(text);
                    segments.forEach(segment => {
                        if (currentBatchLength + segment.length > maxSize) {
                            if (currentBatch.length > 0) {
                                batches.push({
                                    texts: currentBatch,
                                    nodes: [node]
                                });
                            }
                            currentBatch = [segment];
                            currentBatchLength = segment.length;
                        } else {
                            currentBatch.push(segment);
                            currentBatchLength += segment.length;
                        }
                    });
                } else {
                    if (currentBatchLength + text.length > maxSize) {
                        if (currentBatch.length > 0) {
                            batches.push({
                                texts: currentBatch,
                                nodes: [node]
                            });
                        }
                        currentBatch = [text];
                        currentBatchLength = text.length;
                    } else {
                        currentBatch.push(text);
                        currentBatchLength += text.length;
                    }
                }
            });

            if (currentBatch.length > 0) {
                batches.push({
                    texts: currentBatch,
                    nodes: nodes
                });
            }

            return batches;
        },

        async add(nodes) {
            return new Promise((resolve, reject) => {
                this.queue.push({ 
                    nodes, 
                    resolve, 
                    reject,
                    retryCount: 0
                });
                this.processQueue();
            });
        },

        async processQueue() {
            if (this.isProcessing || this.queue.length === 0) return;
            this.isProcessing = true;

            try {
                while (this.queue.length > 0) {
                    const now = Date.now();
                    const timeToWait = Math.max(0, this.minInterval - (now - this.lastRequestTime));
                    if (timeToWait > 0) {
                        await new Promise(resolve => setTimeout(resolve, timeToWait));
                    }

                    const item = this.queue.shift();
                    await this.processItem(item);
                    this.lastRequestTime = Date.now();
                }
            } finally {
                this.isProcessing = false;
            }
        },

        async processItem(item) {
            try {
                const batches = this.splitIntoBatches(item.nodes, 3000); // 增加单批次大小
                const batchPromises = [];
                
                // 并发处理多个批次
                for (let i = 0; i < batches.length; i += this.maxConcurrent) {
                    const currentBatches = batches.slice(i, i + this.maxConcurrent);
                    const promises = currentBatches.map(async batch => {
                        const text = batch.texts.join('\n');
                        try {
                            return await this.translateBatch(text);
                        } catch (error) {
                            if (error.message.includes('Resource has been exhausted')) {
                                // 资源耗尽时等待较长时间
                                await new Promise(resolve => setTimeout(resolve, 5000));
                                return await this.translateBatch(text);
                            }
                            console.error('Batch translation error:', error);
                            return null;
                        }
                    });
                    
                    const results = await Promise.all(promises);
                    batchPromises.push(...results.filter(r => r !== null));
                    
                    // 动�����调整请求间隔
                    if (i + this.maxConcurrent < batches.length) {
                        await new Promise(resolve => 
                            setTimeout(resolve, Math.max(500, this.minInterval))
                        );
                    }
                }

                if (batchPromises.length > 0) {
                    item.resolve(batchPromises.join('\n'));
                } else {
                    throw new Error('所有翻译批次都失败了');
                }
            } catch (error) {
                item.reject(error);
            } finally {
                this.currentConcurrent--;
                this.processQueue();
            }
        },

        async translateBatch(text) {
            let retryCount = 0;
            let delay = this.retryDelay;
            
            while (retryCount <= this.maxRetries) {
                try {
                    this.lastRequestTime = Date.now();
                    const response = await new Promise((resolve, reject) => {
                        chrome.storage.sync.get(['model'], function(result) {
                            chrome.runtime.sendMessage({
                                action: "translateText",
                                text: text,
                                targetLanguage: 'zh',
                                apiKey: apiKey,
                                model: result.model || 'gemini-pro' // 使用保存的模型或默认值
                            }, resolve);
                        });
                    });

            if (response && response.translatedText) {
                        if (response.translatedText.startsWith('翻译请求失败')) {
                            // 如果是 API Key 相关错误，直接抛出不重试
                            if (response.translatedText.includes('API Key')) {
                                throw new Error(response.translatedText);
                            }
                            throw new Error(response.translatedText);
                        }
                        return response.translatedText;
                    }
                    throw new Error('Invalid translation response');
                } catch (error) {
                    console.error(`Translation attempt ${retryCount + 1} failed:`, error);
                    
                    // 如果是 API Key 相关错误，直接抛出不重试
                    if (error.message.includes('API Key')) {
                        throw error;
                    }
                    
                    retryCount++;
                    if (retryCount <= this.maxRetries) {
                        console.log(`Retrying in ${delay}ms...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        delay = Math.min(delay * 1.5, this.maxBackoff);
            } else {
                        throw new Error('翻译请求失败: 多次尝试后仍未成功，请稍后重试');
                    }
                }
            }
        }
    };

    // 修改翻译按钮的创建和状态管理
    function createTranslateButton() {
        console.log('Creating translate button'); // 添加按钮创建日志
        
        const existingButton = document.getElementById('translate-button');
        if (existingButton) {
            console.log('Button already exists, removing old button');
            existingButton.remove();
        }

        const button = document.createElement('button');
        button.id = 'translate-button';
        button.className = 'translate-button';
        button.innerHTML = `
            <span class="button-text">翻译</span>
            <span class="progress-text" style="display: none">0%</span>
        `;
        button.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 10000;
            padding: 10px 20px;
            border: none;
            border-radius: 5px;
            background-color: #4285f4;
            color: white;
            cursor: pointer;
            font-size: 14px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            transition: all 0.3s ease;
        `;
        
        console.log('Adding click event listener'); // 添加事件监听器日志
        button.addEventListener('click', () => {
            console.log('Button clicked, calling handleTranslateClick'); // 添加点击处理日志
            handleTranslateClick();
        });
        
        document.body.appendChild(button);
        translateButton = button;
        console.log('Translate button created and added to page'); // 添加按钮添加完成日志
        return button;
    }

    // 更新翻译进度
    function updateProgress(processed, total) {
        const button = document.getElementById('translate-button');
        if (!button) return;
        
        const buttonText = button.querySelector('.button-text');
        const progressText = button.querySelector('.progress-text');
        
        if (processed === 0 || total === 0) {
            buttonText.style.display = 'inline';
            progressText.style.display = 'none';
            button.style.backgroundColor = '#4285f4';
            return;
        }
        
        const progress = Math.round((processed / total) * 100);
        buttonText.style.display = 'none';
        progressText.style.display = 'inline';
        progressText.textContent = `${progress}%`;
        
        // 根据进度改变按钮颜色
        const hue = Math.round(120 * (progress / 100)); // 从蓝色渐变到绿色
        button.style.backgroundColor = `hsl(${hue}, 70%, 50%)`;
        
        if (progress === 100) {
            setTimeout(() => {
                buttonText.style.display = 'inline';
                progressText.style.display = 'none';
                button.style.backgroundColor = '#4285f4';
                buttonText.textContent = '翻译完成';
                setTimeout(() => {
                    buttonText.textContent = '翻译';
                }, 2000);
            }, 500);
        }
    }

    // 修改翻译函数以支持进度显示
    async function translatePage() {
        const nodes = getTextNodes();
        const totalNodes = nodes.length;
        let processedNodes = 0;
        
        updateProgress(0, totalNodes);
        
        for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
            const batch = nodes.slice(i, i + BATCH_SIZE);
            await translateBatch(batch);
            processedNodes += batch.length;
            updateProgress(processedNodes, totalNodes);
        }
    }

    // 处理翻译按钮点击
    async function handleTranslateClick() {
        console.log('Translation button clicked');

        if (isTranslating) {
            console.log('Already translating, ignoring click');
            return;
        }

        try {
            const getApiKey = () => {
                return new Promise((resolve, reject) => {
                    try {
                        // 确保在 content script 中正确访问 chrome.runtime
                        if (typeof chrome === 'undefined' || !chrome.runtime) {
                            console.error('Chrome runtime not available, trying to reconnect...');
                            // 尝试重新连接
                            setTimeout(() => {
                                if (typeof chrome !== 'undefined' && chrome.runtime) {
                                    chrome.runtime.sendMessage({ action: "getApiKey" }, handleResponse);
                                } else {
                                    reject(new Error('Chrome runtime not available after retry'));
                                }
                            }, 1000);
                            return;
                        }

                        const handleResponse = (response) => {
                            if (chrome.runtime.lastError) {
                                console.error('Runtime error:', chrome.runtime.lastError);
                                reject(chrome.runtime.lastError);
                            } else if (!response || !response.apiKey) {
                                reject(new Error('No API Key found'));
                            } else {
                                resolve(response);
                            }
                        };

                        chrome.runtime.sendMessage({ action: "getApiKey" }, handleResponse);
                    } catch (error) {
                        console.error('Message sending error:', error);
                        reject(error);
                    }
                });
            };

            getApiKey()
                .then(response => {
                    apiKey = response.apiKey;
                    console.log('API Key found, starting translation...');
                    isTranslating = true;
                    updateProgress(0, 1); // 初始化进度
                    return translateVisibleContent();
                })
                .then(() => {
                    console.log('Translation completed successfully');
                    if (!window.hasScrollListener) {
                        window.addEventListener('scroll', handleScroll);
                        window.hasScrollListener = true;
                        console.log('Scroll listener added');
                    }
                })
                .catch(error => {
                    console.error('Translation error:', error);
                    const button = document.getElementById('translate-button');
                    if (button) {
                        const buttonText = button.querySelector('.button-text');
                        if (buttonText) {
                            buttonText.textContent = '翻译失败';
                            button.style.backgroundColor = '#f44336';
                            setTimeout(() => {
                                buttonText.textContent = '翻译';
                                button.style.backgroundColor = '#4285f4';
                            }, 3000);
                        }
                    }
                    if (error.message === 'No API Key found') {
                        alert('请先在插件设置中配置API Key');
                    }
                })
                .finally(() => {
                    isTranslating = false;
                    console.log('Translation process finished');
                });
        } catch (error) {
            console.error('Error getting API Key:', error);
            alert('获取API Key失败，请检查插件设置');
        }
    }

    // 优化滚动检测函数
    let scrollTimeout;
    function handleScroll() {
        if (scrollTimeout) {
            clearTimeout(scrollTimeout);
        }
        
        scrollTimeout = setTimeout(async () => {
            if (isTranslating) return;
            
            const viewportHeight = window.innerHeight;
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            const scrollBottom = scrollTop + viewportHeight;
            
            // 增加预加载范围，提前 1000px 开始检测
            const preloadDistance = 1000;
            
            // 获取在可视区域及预加载范围内的未翻译节点
            const untranslatedNodes = getVisibleTextNodes().filter(node => {
                const rect = node.parentElement.getBoundingClientRect();
                const nodeTop = rect.top + scrollTop;
                const nodeBottom = rect.bottom + scrollTop;
                
                return !originalTexts.has(node) && 
                       nodeBottom >= (scrollTop - preloadDistance) && 
                       nodeTop <= (scrollBottom + preloadDistance);
            });

            if (untranslatedNodes.length > 0) {
                try {
                    console.log(`Found ${untranslatedNodes.length} new nodes to translate`);
                    await translateNodes(untranslatedNodes);
                } catch (error) {
                    console.error('Translation error during scroll:', error);
                }
            }
        }, 100); // 减少延迟时间以提高响应速度
    }

    // 修改翻译节点的函数
    async function translateNodes(nodes) {
        if (nodes.length === 0) return;

        try {
            isTranslating = true;
            const translations = await requestLimiter.add(nodes);
            
            if (translations) {
                const translationArray = translations.split('\n');
                let translationIndex = 0;

                nodes.forEach(node => {
                    const originalText = node.textContent.trim();
                    if (originalText) {
                        originalTexts.set(node, originalText);
                        if (translationArray[translationIndex]) {
                            node.textContent = translationArray[translationIndex];
                            translationIndex++;
                        }
                    }
                });
            }
        } catch (error) {
            console.error('Translation error:', error);
            throw error;
        } finally {
            isTranslating = false;
        }
    }

    // 修改获取可见文本节点的函数
    function getVisibleTextNodes() {
        const textNodes = [];
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    // 增加更多需要排除的元素
                    const excludeTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'META', 'LINK', 'BUTTON'];
                    const excludeClasses = ['translate-button', 'progress-text', 'button-text'];
                    
                    if (node.parentElement && (
                        excludeTags.includes(node.parentElement.tagName) ||
                        node.parentElement.closest('[contenteditable]') ||
                        excludeClasses.some(cls => node.parentElement.classList.contains(cls)) ||
                        node.parentElement.closest('[role="button"]') ||
                        node.parentElement.closest('svg') ||
                        node.parentElement.closest('img')
                    )) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    const text = node.textContent.trim();
                    if (!text || text.length < 2) { // 忽略太短的文本
                        return NodeFilter.FILTER_REJECT;
                    }

                    // 检查是否在视口范围内或接近视口
                    const rect = node.parentElement.getBoundingClientRect();
                    const isNearViewport = rect.top < window.innerHeight + 500 && // 增加检测范围
                                         rect.bottom >= -500 &&
                                         rect.left < window.innerWidth &&
                                         rect.right >= 0;

                    const style = window.getComputedStyle(node.parentElement);
                    const isVisible = style.display !== 'none' &&
                                    style.visibility !== 'hidden' &&
                                    style.opacity !== '0' &&
                                    parseFloat(style.opacity) > 0;

                    return isNearViewport && isVisible ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            }
        );

        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        return textNodes;
    }

    // 修改翻译可见内容的函数
    async function translateVisibleContent() {
        try {
            const visibleTextNodes = getVisibleTextNodes();
            if (visibleTextNodes.length === 0) return;

            const totalNodes = visibleTextNodes.length;
            let processedNodes = 0;
            updateProgress(0, totalNodes);

            // 增加批次大小
            const batchSize = 5;
            const batches = [];
            
            // 按批次分组
            for (let i = 0; i < visibleTextNodes.length; i += batchSize) {
                batches.push(visibleTextNodes.slice(i, i + batchSize));
            }

            // 并发处理多个批次
            const concurrentBatches = 3; // 同时处理3个批次
            for (let i = 0; i < batches.length; i += concurrentBatches) {
                const currentBatches = batches.slice(i, i + concurrentBatches);
                const promises = currentBatches.map(async batch => {
                    try {
                        await translateNodes(batch);
                        processedNodes += batch.length;
                        updateProgress(processedNodes, totalNodes);
                    } catch (error) {
                        console.error('Batch translation error:', error);
                        if (!error.message.includes('请求过于频繁')) {
                            throw error;
                        }
                    }
                });

                await Promise.all(promises);
                
                // 添加短暂延迟避免请求过于密集
                if (i + concurrentBatches < batches.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            updateProgress(totalNodes, totalNodes);
        } catch (error) {
            console.error('Translation error:', error);
            throw error;
        }
    }

    // 初始化
    document.addEventListener('DOMContentLoaded', () => {
        console.log('DOM Content Loaded, initializing...'); // 添加初始化日志
        createTranslateButton();
    });

    // 为了处理可能的动态加载情况，也在这里直接调用
    console.log('Content script executing immediately'); // 添加脚本执行日志
    createTranslateButton();
})();