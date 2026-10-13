// PM2 process file. Build first (npm run build), then: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'avrstk-bot',
      script: 'dist/index.js',
      // .env and data/groups.json are read relative to the working directory
      cwd: __dirname,

      // Exactly one instance: Telegram allows only one process polling a bot token
      // at a time (a second one gets "409 Conflict"), so never use cluster mode here.
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      // Back off between crash restarts (100ms, 150ms, ... up to 15s) instead of looping
      exp_backoff_restart_delay: 100,
      max_memory_restart: '300M',
      watch: false,

      // Give the bot time to stop polling cleanly on restart (it handles SIGINT)
      kill_timeout: 5000,

      // Prefix each log line with the date (the bot's own lines only carry the time)
      time: true,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
