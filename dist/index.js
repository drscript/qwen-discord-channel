import { DiscordChannel } from "./discord-channel.js";
export const plugin = {
    channelType: "discord",
    displayName: "Discord",
    requiredConfigFields: ["token"],
    createChannel: (name, config, bridge, options) => new DiscordChannel(name, config, bridge, options),
};
