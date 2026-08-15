/**
 * Ollama Local Hybrid Bridge Script
 * Offloads routine AI tasks (tests, docs, refactoring, type stubs) to local Ollama (qwen2.5-coder)
 * zero token cost, automatic project context injection from AGENTS.md.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {
    mode: 'docs',
    model: 'qwen2.5-coder',
    filePath: null,
    instruction: '',
    outputFile: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' && args[i + 1]) {
      flags.model = args[++i];
    } else if ((arg === '-o' || arg === '--out') && args[i + 1]) {
      flags.outputFile = args[++i];
    } else if (!flags.modeSet) {
      flags.mode = arg;
      flags.modeSet = true;
    } else if (!flags.filePath) {
      flags.filePath = arg;
    } else {
      flags.instruction += (flags.instruction ? ' ' : '') + arg;
    }
  }

  return flags;
}

async function runOllama() {
  const flags = parseArgs();

  if (!flags.filePath && flags.mode !== 'prompt') {
    console.error('Usage: node scripts/ollama-exec.js <tests|docs|refactor|prompt> <file-path> [instructions] [--model qwen2.5-coder] [-o output-file]');
    process.exit(1);
  }

  let fileContent = '';
  if (flags.filePath && fs.existsSync(flags.filePath)) {
    fileContent = fs.readFileSync(flags.filePath, 'utf8');
  }

  let agentsRule = '';
  const agentsPath = path.resolve(process.cwd(), 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    agentsRule = fs.readFileSync(agentsPath, 'utf8');
  }

  const promptTemplates = {
    tests: `Generate clean, robust unit tests for the code below. Use standard testing framework conventions.\n\nFile: ${flags.filePath}\nCode:\n\`\`\`\n${fileContent}\n\`\`\`\n${flags.instruction ? 'Additional Instructions: ' + flags.instruction : ''}`,
    docs: `Add complete, clear JSDoc / documentation comments and type annotations to the code below.\n\nFile: ${flags.filePath}\nCode:\n\`\`\`\n${fileContent}\n\`\`\``,
    refactor: `Refactor the code below for maximum readability, safety, and modern performance.\n\nInstructions: ${flags.instruction || 'Improve code structure and eliminate redundant logic.'}\nCode:\n\`\`\`\n${fileContent}\n\`\`\``,
    prompt: `${flags.instruction} ${fileContent ? '\n\nContext:\n```\n' + fileContent + '\n```' : ''}`
  };

  const userPrompt = promptTemplates[flags.mode] || promptTemplates.prompt;

  const systemMessage = `You are a high-performance local AI coding assistant. Follow these workspace rules:\n\n${agentsRule}`;

  const payload = JSON.stringify({
    model: flags.model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userPrompt }
    ],
    stream: false
  });

  console.log(`[Ollama Bridge] Dispatching ${flags.mode} task to local model '${flags.model}'...`);

  const req = http.request({
    hostname: '127.0.0.1',
    port: 11434,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, (res) => {
    let rawData = '';
    res.on('data', chunk => rawData += chunk);
    res.on('end', () => {
      try {
        const response = JSON.parse(rawData);
        if (response.choices && response.choices.length > 0) {
          const content = response.choices[0].message.content;
          if (flags.outputFile) {
            fs.writeFileSync(flags.outputFile, content, 'utf8');
            console.log(`[Ollama Bridge] Output successfully written to ${flags.outputFile}`);
          } else {
            console.log('\n--- OLLAMA GENERATED OUTPUT ---\n');
            console.log(content);
            console.log('\n--- END OLLAMA OUTPUT ---\n');
          }
        } else {
          console.error('[Ollama Bridge Error] Unexpected API response format:', rawData);
        }
      } catch (err) {
        console.error('[Ollama Bridge Error] Failed to parse Ollama response:', err.message);
        console.log('Raw output:', rawData);
      }
    });
  });

  req.on('error', (e) => {
    console.error(`[Ollama Bridge Error] Could not connect to Ollama at http://127.0.0.1:11434 - Is Ollama running? (${e.message})`);
  });

  req.write(payload);
  req.end();
}

runOllama();
