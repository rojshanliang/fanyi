// content.js
console.log('Content script loaded');

class TranslationManager {
  constructor() {
    this.isTranslating = false;
    this.shouldStop = false;
    this.currentProgress = 0;
    this.queue = [];
    this.batchSize = 5;
    this.retryDelay = 3000;
    this.maxRetries = 3;
    this.button = null;
    this.originalButtonText = '';
  }

  initialize(button) {
    this.button = button;
    this.originalButtonText = button.textContent;

    this.setupButtonEvents();

    // 添加鼠标悬停事件监听
    this.button.addEventListener('mouseover', () => {
      if (this.isTranslating) {
        this.button.textContent = '停止';
      }
    });

    this.button.addEventListener('mouseout', () => {
      if (this.isTranslating) {
        this.button.textContent = `${this.currentProgress}%`;
      } else {
        this.button.textContent = this.originalButtonText;
      }
    });
  }

  setupButtonEvents() {
    if (!this.button) return;
    
    this.button.addEventListener('click', () => this.handleClick());
    this.button.addEventListener('mouseenter', () => this.handleHover());
    this.button.addEventListener('mouseleave', () => this.handleHoverEnd());
  }

  handleClick() {
    if (this.isTranslating) {
      this.stop();
    } else {
      this.start();
    }
  }

  handleHover() {
    if (this.isTranslating) {
      this.button.dataset.originalText = this.button.textContent;
      this.button.textContent = '停止';
      this.button.style.backgroundColor = '#ff4444';
    }
  }

  handleHoverEnd() {
    if (this.isTranslating && this.button.dataset.originalText) {
      this.button.textContent = this.button.dataset.originalText;
      this.button.style.backgroundColor = '#4CAF50';
    }
  }

  async start() {
    if (this.isTranslating) return;
    
    this.isTranslating = true;
    this.shouldStop = false;
    this.currentProgress = 0;
    this.queue = [];
    
    try {
      const nodes = this.collectTextNodes(document.body);
      await this.translateNodes(nodes);
    } catch (error) {
      console.error('Translation error:', error);
      this.updateButtonError();
    } finally {
      this.reset();
    }
  }

  stop() {
    if (!this.isTranslating) return;
    
    this.shouldStop = true;
    console.log('正在停止翻译...');
  }

  reset() {
    this.isTranslating = false;
    this.shouldStop = false;
    this.currentProgress = 0;
    this.queue = [];
    this.updateButtonNormal();
  }

  updateProgress(progress) {
    this.currentProgress = progress;
    if (this.button && !this.button.matches(':hover')) {
      this.button.textContent = `${progress}%`;
    }
  }

  updateButtonError(message = '错误') {
    if (this.button) {
      this.button.style.backgroundColor = '#ff4444';
      this.button.textContent = message;
      setTimeout(() => this.updateButtonNormal(), 2000);
    }
  }

  updateButtonNormal() {
    if (this.button) {
      this.button.style.backgroundColor = '#4CAF50';
      this.button.textContent = this.originalButtonText;
    }
  }

  collectTextNodes(node) {
    const nodes = [];
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          if (this.shouldSkipNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currentNode;
    while (currentNode = walker.nextNode()) {
      nodes.push(currentNode);
    }
    return nodes;
  }

  shouldSkipNode(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    
    const style = window.getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    
    const ignoreTags = ['SCRIPT', 'STYLE', 'CODE', 'PRE'];
    if (ignoreTags.includes(parent.tagName)) return true;
    
    return false;
  }

  async translateNodes(nodes) {
    const totalNodes = nodes.length;

    for (let i = 0; i < totalNodes; i++) {
      if (this.shouldStop) {
        console.log('翻译已停止');
        break;
      }

      const node = nodes[i];

      try {
        await this.translateBatch([node]);
      } catch (error) {
        if (error.message.includes('Resource has been exhausted')) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          nodes.push(node); // 重新加入队列
          continue;
        }
        throw error;
      }

      // 更新进度
      let progress = Math.floor(((i + 1) / totalNodes) * 100);
      this.updateProgress(progress);
    }
  }

  createBatches(nodes, size) {
    const batches = [];
    for (let i = 0; i < nodes.length; i += size) {
      batches.push(nodes.slice(i, i + size));
    }
    return batches;
  }

  async translateBatch(nodes) {
    const texts = nodes.map(node => node.textContent.trim());
    const translations = await this.requestTranslations(texts);
    
    nodes.forEach((node, index) => {
      if (translations[index]) {
        node.textContent = translations[index];
      }
    });
  }

  async requestTranslations(texts) {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error('API Key not found');

    const response = await chrome.runtime.sendMessage({
      type: 'translateText',
      text: texts.join('\n'),
      targetLang: 'zh'
    });

    if (!response || typeof response !== 'object') {
      throw new Error('Invalid response from background script');
    }

    if (response.error) {
      throw new Error(response.error);
    }

    return texts.map((_, index) => response.translatedText?.split('\n')[index]).filter(Boolean);
  }

  async getApiKey() {
    try {
      const response = await chrome.runtime.sendMessage({ 
        type: 'getApiKey'
      });
      
      if (chrome.runtime.lastError) {
        console.error('Runtime error:', chrome.runtime.lastError);
        throw new Error('Failed to get API Key');
      }

      if (!response || !response.apiKey) {
        throw new Error('No API Key found');
      }

      return response.apiKey;
    } catch (error) {
      console.error('Error getting API Key:', error);
      throw new Error('请先在插件设置中配置API Key');
    }
  }

  async validateApiKey(apiKey) {
    const response = await chrome.runtime.sendMessage({
        type: 'validateApiKey',
        apiKey: apiKey
    });

    if (!response || typeof response !== 'object') {
        throw new Error('Invalid response from background script');
    }

    if (!response.isValid) {
        throw new Error('API Key validation failed');
    }

    return response.models;
  }
}

// 创建翻译按钮
function createTranslateButton() {
  const button = document.createElement('button');
  button.textContent = '翻译';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 10px 20px;
    background-color: #4CAF50;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    z-index: 10000;
    font-size: 16px;
    transition: background-color 0.3s;
  `;

  document.body.appendChild(button);
  
  const manager = new TranslationManager();
  manager.initialize(button);
}

// 初始化
console.log('Content script loaded');
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createTranslateButton);
} else {
  createTranslateButton();
}