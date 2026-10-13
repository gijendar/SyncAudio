module.exports = {
  apps: [
    {
      name: 'syncaudio',
      script: 'server/index.js',
      instances: 'max', // cluster mode: one worker per CPU core
      exec_mode: 'cluster',
      node_args: ['--enable-source-maps'],
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      // Log files — rotate with `pm2 install pm2-logrotate`.
      error_file: './pm2-error.log',
      out_file: './pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Graceful shutdown: PM2 waits up to 30s for the process to exit.
      kill_timeout: 30000,
      listen_timeout: 30000,
      // Restart on crash.
      max_restarts: 10,
      min_uptime: '10s',
      // Watch mode disabled in production.
      watch: false,
      ignore_watch: ['node_modules', 'client/dist', '.syncaudio-uploads', 'logs'],
    },
  ],
};
