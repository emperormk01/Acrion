const token = process.argv[2];
const url = process.argv[3];

if (!token || !url) {
  console.log("Usage: npx tsx set_telegram_webhook.ts <TELEGRAM_BOT_TOKEN> <YOUR_CF_WORKER_URL>");
  process.exit(1);
}

const webhookUrl = `${url.replace(/\/$/, '')}/api/telegram`;

async function setWebhook() {
  console.log(`Setting webhook for bot to ${webhookUrl}...`);
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`);
  const data = await response.json();
  
  if (data.ok) {
    console.log("✅ Webhook set successfully!");
  } else {
    console.error("❌ Failed to set webhook:");
    console.error(data);
  }
  
  console.log(`Setting bot commands...`);
  const commandsRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: "start", description: "Start the bot and see available commands" },
        { command: "status", description: "Get agent status & active positions" },
        { command: "trade", description: "Trigger a manual CFD/Options trade cycle" },
        { command: "amount", description: "Configure trading amounts (Stake, Lots, Leverage)" },
        { command: "settings", description: "Manage account type (Demo/Real) and AI settings" },
        { command: "report", description: "Fetch the latest trading report" },
        { command: "memory", description: "View the agent's persistent self-evolution memory" },
        { command: "model", description: "Switch between Poolside and Gemini AI models" },
        { command: "key", description: "Manage your personal AI API keys" },
        { command: "auto", description: "Setup automated trade scheduling control panel" }
      ]
    })
  });
  
  const commandsData = await commandsRes.json();
  if (commandsData.ok) {
    console.log("✅ Bot commands set successfully!");
  } else {
    console.error("❌ Failed to set bot commands:");
    console.error(commandsData);
  }
}

setWebhook();
