import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelBase, } from "@qwen-code/channel-base";
import { Client, GatewayIntentBits, Partials, Routes, } from "discord.js";
/** Discord message content limit. */
const MAX_MESSAGE_CHARS = 2000;
/** Attachments beyond this size are saved to disk and handed to the agent as file paths. */
const INLINE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
/** Discord expires typing indicators after ~10s; repeat while the agent works. */
const TYPING_INTERVAL_MS = 5000;
function chunkText(text) {
    if (text.length <= MAX_MESSAGE_CHARS) {
        return [text];
    }
    const chunks = [];
    let rest = text;
    while (rest.length > MAX_MESSAGE_CHARS) {
        let cut = rest.lastIndexOf("\n", MAX_MESSAGE_CHARS);
        if (cut < MAX_MESSAGE_CHARS / 2) {
            cut = MAX_MESSAGE_CHARS;
        }
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.length > 0) {
        chunks.push(rest);
    }
    return chunks;
}
export class DiscordChannel extends ChannelBase {
    client;
    botId = "";
    botUsername = "";
    typingIntervals = new Map();
    activeTypingSessions = new Map();
    constructor(name, config, bridge, options) {
        super(name, config, bridge, options);
        this.client = this.createClient();
        this.registerCancelCommand();
    }
    createClient() {
        return new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessages,
                // Privileged intent — must be enabled in the Discord developer portal.
                GatewayIntentBits.MessageContent,
            ],
            // Required to receive DMs from users who share no guild with the bot.
            partials: [Partials.Channel],
        });
    }
    async connect() {
        const token = this.config.token;
        if (!token) {
            throw new Error(`Discord channel "${this.name}" has no token configured`);
        }
        this.client.on("messageCreate", (msg) => {
            void this.onMessage(msg).catch((err) => {
                process.stderr.write(`[Discord:${this.name}] Error handling message: ${err instanceof Error ? err.message : err}\n`);
            });
        });
        this.client.on("error", (err) => {
            process.stderr.write(`[Discord:${this.name}] Client error: ${err instanceof Error ? err.message : err}\n`);
        });
        await this.client.login(token);
        this.botId = this.client.user?.id ?? "";
        this.botUsername = this.client.user?.username ?? "";
    }
    disconnect() {
        for (const interval of this.typingIntervals.values()) {
            clearInterval(interval);
        }
        this.typingIntervals.clear();
        this.activeTypingSessions.clear();
        void this.client.destroy();
    }
    async sendMessage(chatId, text) {
        for (const chunk of chunkText(text)) {
            await this.client.rest.post(Routes.channelMessages(chatId), {
                body: { content: chunk },
            });
        }
    }
    supportsProactiveSend() {
        return true;
    }
    supportsProactiveTarget(_target) {
        // chatId is always a deliverable Discord channel id (threads included).
        return true;
    }
    async pushProactive(target, text) {
        await this.sendMessage(target.chatId, text);
    }
    onPromptStart(chatId, sessionId) {
        const sessions = this.activeTypingSessions.get(chatId) ?? new Set();
        sessions.add(sessionId);
        this.activeTypingSessions.set(chatId, sessions);
        if (this.typingIntervals.has(chatId)) {
            return;
        }
        const sendTyping = () => {
            this.client.rest
                .post(Routes.channelTyping(chatId))
                .catch(() => {
                // Typing is best-effort; a stale channel id must not kill the session.
            });
        };
        sendTyping();
        this.typingIntervals.set(chatId, setInterval(sendTyping, TYPING_INTERVAL_MS));
    }
    onPromptEnd(chatId, sessionId) {
        const sessions = this.activeTypingSessions.get(chatId);
        if (sessions) {
            sessions.delete(sessionId);
            if (sessions.size > 0) {
                return;
            }
            this.activeTypingSessions.delete(chatId);
        }
        const interval = this.typingIntervals.get(chatId);
        if (!interval) {
            return;
        }
        clearInterval(interval);
        this.typingIntervals.delete(chatId);
    }
    async onMessage(msg) {
        if (msg.author.bot || !this.client.user) {
            return;
        }
        const isGroup = msg.guildId !== null;
        const isMentioned = msg.mentions.users.has(this.client.user.id);
        const isReplyToBot = msg.mentions.repliedUser?.id === this.client.user.id;
        let cleanText = msg.content;
        if (this.botId) {
            cleanText = cleanText
                .replace(new RegExp(`<@!?${this.botId}>`, "g"), "")
                .trim();
        }
        const referencedId = msg.reference?.messageId;
        const referenced = referencedId
            ? msg.channel.messages.cache.get(referencedId)
            : undefined;
        const envelope = {
            channelName: this.name,
            senderId: msg.author.id,
            senderName: msg.author.displayName || msg.author.username,
            chatId: msg.channelId,
            ...(isGroup && msg.guild?.name ? { chatName: msg.guild.name } : {}),
            threadId: msg.channel.isThread() ? msg.channelId : undefined,
            messageId: msg.id,
            text: cleanText || (msg.attachments.size > 0 ? "(attachment)" : ""),
            isGroup,
            isMentioned,
            isReplyToBot,
            referencedText: referenced?.content,
            mentionedMemberIds: msg.mentions.users
                .filter((user) => !user.bot && user.id !== this.botId)
                .map((user) => user.id),
        };
        const attachments = await this.collectAttachments(msg);
        if (attachments.length > 0) {
            envelope.attachments = attachments;
        }
        await this.handleInbound(envelope);
    }
    async collectAttachments(msg) {
        const attachments = [];
        for (const attachment of msg.attachments.first(MAX_ATTACHMENTS)) {
            try {
                const mimeType = attachment.contentType ?? "application/octet-stream";
                if (mimeType.startsWith("image/") && attachment.size <= INLINE_ATTACHMENT_BYTES) {
                    const response = await fetch(attachment.url);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const data = Buffer.from(await response.arrayBuffer()).toString("base64");
                    attachments.push({
                        type: "image",
                        data,
                        mimeType,
                        fileName: attachment.name ?? undefined,
                    });
                }
                else {
                    const response = await fetch(attachment.url);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const buffer = Buffer.from(await response.arrayBuffer());
                    const dir = join(tmpdir(), "channel-files");
                    if (!existsSync(dir)) {
                        mkdirSync(dir, { recursive: true });
                    }
                    const fileName = attachment.name ?? attachment.id;
                    const filePath = join(dir, fileName);
                    writeFileSync(filePath, buffer);
                    attachments.push({
                        type: mimeType.startsWith("audio/")
                            ? "audio"
                            : mimeType.startsWith("video/")
                                ? "video"
                                : "file",
                        filePath,
                        mimeType,
                        fileName,
                    });
                }
            }
            catch (err) {
                process.stderr.write(`[Discord:${this.name}] Failed to download attachment: ${err instanceof Error ? err.message : err}\n`);
            }
        }
        return attachments;
    }
}
