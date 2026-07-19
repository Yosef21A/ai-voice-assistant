// Public entrypoint for the outbound WhatsApp module.
//   import { createSender } from '../whatsapp/index.js';
//   const wa = createSender({ onOutbound: (rec) => store.logMessage(rec) });
//   await wa.sendText(tenant, waId, 'Bonjour');
export { createSender, WhatsAppSender, default } from './sender.js';
export {
  WhatsAppError,
  AuthError,
  RateLimited,
  InvalidRecipient,
  WindowExpired,
  TransportError,
  classifyHttpError,
  classifyNetworkError,
  parseRetryAfter,
  toPlainError,
} from './errors.js';
