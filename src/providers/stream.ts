import { Socket } from 'net';
import { Response } from 'express';
import connectionProvider from './connection';
import dgram from 'dgram';
const debug = require('debug')('iptv-restream:receiver')

class StreamProvider {

    public stream(mcast_source: string, mcast_group: string, mcast_port: number, socket: Socket, res: Response) {
        return new Promise(async (resolve, reject) => {
            debug(`Client requested ${mcast_source}@${mcast_group}:${mcast_port}.`);
            const receiver = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            receiver.on('error', (err: Error) => {
                debug(`Error (receiver): ${err}`);
                reject(`Error (receiver): ${err}`);
            });

            receiver.bind(mcast_port, mcast_group);
            receiver.on('listening', function () {
                debug(`adding SSM for ${mcast_source}@${mcast_group}:${mcast_port}`);
                receiver.addSourceSpecificMembership(mcast_source, mcast_group);
            });

            receiver.on('message', function (message: Buffer) {
                // https://en.wikipedia.org/wiki/Real-time_Transport_Protocol
                // https://en.wikipedia.org/wiki/MPEG_transport_stream
                // https://www.etsi.org/deliver/etsi_en/300400_300499/300468/01.14.01_60/en_300468v011401p.pdf - 5.2.4 Event Information Table, 6.2.37 Short event descriptor

                const mpegtsPacket = Buffer.from(message).slice(12);
                res.write(mpegtsPacket);

                const packetCount = mpegtsPacket.length / 188;
                for (let packetNumber = 0; packetNumber < packetCount; packetNumber++) {
                    const offset = packetNumber * 188 + 4 + 1;
                    const header = mpegtsPacket.readUInt32BE(packetNumber * 188);
                    const payloadUnitStartIndicator = (header & 0x400000) !== 0;
                    const pid = (header & 0x1fff00) >>> 8;
                    if (pid == 0x12 && payloadUnitStartIndicator) {
                        const event_information_section6 = mpegtsPacket.readUInt32BE(offset + 24);
                        const running_status = (event_information_section6 & 0xE0000000) >>> 29;
                        if (running_status !== 4)
                            continue;
                        const descriptor = mpegtsPacket.readUInt32BE(offset + 26);
                        const descriptor_tag = (descriptor & 0xFF000000) >> 24;
                        if (descriptor_tag !== 0x4D)
                            continue;
                        const event_information_section8 = mpegtsPacket.readUInt32BE(offset + 30);
                        const event_name_length = (event_information_section8 & 0xFF0000) >> 16;
                        let event_name = mpegtsPacket.slice(offset + 32, offset + 32 + event_name_length);
                        if (event_name[0] === 0x05) {
                            event_name = event_name.slice(1, event_name.length);
                        }
                        let event_name_string = '';
                        for (let i = 0; i < event_name_length; i++) {
                            event_name_string += String.fromCharCode(event_name[i]);
                        }
                        try {
                            debug(`Received program for ${mcast_source}@${mcast_group}:${mcast_port}: "${event_name_string}"`)
                            connectionProvider.setProgram(socket, event_name_string);
                        } catch (error) {
                            debug(`Could not set program "${event_name_string}" for socket. Probably already disconnected?`);
                        }
                    }
                }
            });

            socket.on('close', () => {
                receiver.close();
                debug(`Client ${socket.remoteAddress}:${socket.remotePort} disconnected. Closing receiver.`);
                resolve();
            });
        });
    }
}

export default StreamProvider;