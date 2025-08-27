const https = require('https');
const { URL } = require('url');

class OpenAIClient {
  constructor(keyRotator, baseUrl = 'https://api.openai.com') {
    this.keyRotator = keyRotator;
    this.baseUrl = baseUrl;
    // SSL retry configuration
    this.requestRetryConfig = {
      maxRetries: 10,
      baseDelay: 10, // 10 milliseconds
      backoffFactor: 2,
      maxDelay: 100 // 100 milliseconds
    };
  }

  async makeRequest(method, path, body, headers = {}) {
    // Create a new request context for this specific request
    const requestContext = this.keyRotator.createRequestContext();
    let lastError = null;
    let lastResponse = null;
    
    // Try each available key for this request
    let apiKey;
    while ((apiKey = requestContext.getNextKey()) !== null) {
      const maskedKey = this.maskApiKey(apiKey);
      
      console.log(`[OPENAI::${maskedKey}] Attempting ${method} ${path}`);
      
      try {
        const response = await this.sendRequest(method, path, body, headers, apiKey);
        
        if (response.statusCode === 429) {
          console.log(`[OPENAI::${maskedKey}] Rate limited (429) - trying next key`);
          requestContext.markKeyAsRateLimited(apiKey);
          lastResponse = response; // Keep the 429 response in case all keys fail
          continue;
        }

        // Check for soft rate limits in the response body (HTTP 200 OK with error details)
        if (response.statusCode === 200) {
          try {
            const responseJson = JSON.parse(response.data);
            if (responseJson.error && (responseJson.error.code === "429" || responseJson.error.type === "rate_limit_exceeded")) {
              console.log(`[OPENAI::${maskedKey}] Soft rate limited (200 OK with 429 in body) - trying next key`);
              requestContext.markKeyAsRateLimited(apiKey);
              lastResponse = response; // Keep the response in case all keys fail
              continue;
            }
          } catch (e) {
            // If response is not JSON or parsing fails, it's not a soft rate limit error we're looking for
          }
        }
        
        console.log(`[OPENAI::${maskedKey}] Success (${response.statusCode})`);
        return response;
      } catch (error) {
        console.log(`[OPENAI::${maskedKey}] Request failed: ${error.message}`);
        lastError = error;
        // For non-429 errors, we still try the next key
        continue;
      }
    }
    
    // All keys have been tried for this request
    const stats = requestContext.getStats();
    console.log(`[OPENAI] All ${stats.totalKeys} keys tried for this request. ${stats.rateLimitedKeys} were rate limited.`);
    
    // Update the KeyRotator with the last failed key from this request
    const lastFailedKey = requestContext.getLastFailedKey();
    this.keyRotator.updateLastFailedKey(lastFailedKey);
    
    // If all tried keys were rate limited, return 429
    if (requestContext.allTriedKeysRateLimited()) {
      console.log('[OPENAI] All keys rate limited for this request - returning 429');
      return lastResponse || {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          error: {
            message: 'All OpenAI API keys have been rate limited for this request',
            type: 'rate_limit_exceeded',
            code: 'rate_limit_exceeded'
          }
        })
      };
    }
    
    // If we had other types of errors, throw the last one
    if (lastError) {
      throw lastError;
    }
    
    // Fallback error
    throw new Error('All API keys exhausted without clear error');
  }

  async sendRequest(method, path, body, headers, apiKey, retryCount = 0) {
    return new Promise((resolve, reject) => {
      // Construct full URL - handle cases where path might be empty or just "/"
      let fullUrl;
      if (!path || path === '/') {
        fullUrl = this.baseUrl;
      } else if (path.startsWith('/')) {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path.substring(1) : this.baseUrl + path;
      } else {
        fullUrl = this.baseUrl.endsWith('/') ? this.baseUrl + path : this.baseUrl + '/' + path;
      }
      
      const url = new URL(fullUrl);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...headers
        }
      };

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        options.headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: data
          });
        });
      });

      req.on('error', async (error) => {
        const maskedKey = this.maskApiKey(apiKey);
        
        // Check if this is a retriable error and we haven't exceeded retry limit
        if (this.isRetriableError(error.message) && retryCount < this.requestRetryConfig.maxRetries) {
          const delay = Math.min(
            this.requestRetryConfig.baseDelay * Math.pow(this.requestRetryConfig.backoffFactor, retryCount),
            this.requestRetryConfig.maxDelay
          );
          
          console.log(`[OPENAI::${maskedKey}] Retriable error (attempt ${retryCount + 1}/${this.requestRetryConfig.maxRetries}): ${error.message}`);
          console.log(`[OPENAI::${maskedKey}] Retrying in ${delay}ms...`);
          
          setTimeout(async () => {
            try {
              const result = await this.sendRequest(method, path, body, headers, apiKey, retryCount + 1);
              resolve(result);
            } catch (retryError) {
              reject(retryError);
            }
          }, delay);
        } else {
          // Either not a retriable error or exceeded retry limit
          if (this.isRetriableError(error.message)) {
            console.log(`[OPENAI::${maskedKey}] Retriable error - max retries (${this.requestRetryConfig.maxRetries}) exceeded: ${error.message}`);
          } else {
            console.log(`[OPENAI::${maskedKey}] Request failed: ${error.message}`);
          }
          reject(error);
        }
      });

      if (body && method !== 'GET') {
        const bodyData = typeof body === 'string' ? body : JSON.stringify(body);
        req.write(bodyData);
      }

      req.end();
    });
  }

  maskApiKey(key) {
    if (!key || key.length < 8) return '***';
    return key.substring(0, 4) + '...' + key.substring(key.length - 4);
  }

  isSSLError(errorMessage) {
    if (!errorMessage) return false;
    return errorMessage.includes('SSL routines') ||
           errorMessage.includes('ssl3_read_bytes') ||
           errorMessage.includes('bad record mac') ||
           errorMessage.includes('SSL alert');
  }

  isRetriableError(errorMessage) {
    if (!errorMessage) return false;
    // ECONNRESET indicates connection was reset by peer
    return errorMessage.includes('ECONNRESET') || this.isSSLError(errorMessage);
  }
}

module.exports = OpenAIClient;