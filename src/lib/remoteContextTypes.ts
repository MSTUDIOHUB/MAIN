export interface FeishuRemoteContext {
  adapter: "feishu";
  chatId: string;
  userId: string;
  userName: string;
  messageId?: string;
}
