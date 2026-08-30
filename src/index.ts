import type { ChannelPlugin } from "@qwen-code/channel-base";
import { DiscordChannel } from "./discord-channel.js";

export const plugin: ChannelPlugin = {
  channelType: "discord",
  displayName: "Discord",
  requiredConfigFields: ["token"],
  createChannel: (name, config, bridge, options) =>
    new DiscordChannel(name, config, bridge, options),
};
