export {};
/**
 * 抓包服务日志（轻量控制台输出）
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info') {
  const threshold = LEVELS[String(level || 'info').toLowerCase()] ?? LEVELS.info;

  function write(levelName, message, extra) {
    if (LEVELS[levelName] < threshold) return;
    const time = new Date().toISOString();
    const extraText = extra && typeof extra === 'object'
      ? ` ${JSON.stringify(extra)}`
      : (extra ? ` ${extra}` : '');
    console[levelName === 'error' ? 'error' : 'log'](
      `[${time}] [capture] [${levelName.toUpperCase()}] ${message}${extraText}`,
    );
  }

  const log = (levelName, message, extra) => write(String(levelName || 'info').toLowerCase(), message, extra);
  log.debug = (message, extra) => write('debug', message, extra);
  log.info = (message, extra) => write('info', message, extra);
  log.warn = (message, extra) => write('warn', message, extra);
  log.error = (message, extra) => write('error', message, extra);
  return log;
}

module.exports = { createLogger };
