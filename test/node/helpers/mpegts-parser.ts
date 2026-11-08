// A small, independent MPEG-TS parser for checking what the muxer writes: packet headers, adaptation fields, PSI
// sections and PES packets. It follows ISO/IEC 13818-1 as implemented by FFmpeg's mpegts.c and Chromium's
// media/formats/mp2t, and is deliberately strict, so it reports anything it finds odd instead of guessing.

export type ParsedTsPacket = {
	index: number;
	pid: number;
	payloadUnitStart: boolean;
	transportErrorIndicator: boolean;
	scramblingControl: number;
	adaptationFieldControl: number;
	continuityCounter: number;
	adaptation: {
		length: number;
		discontinuity: boolean;
		randomAccess: boolean;
		pcr: number | null;
		stuffingBytes: number[];
	} | null;
	payload: Uint8Array;
};

export type ParsedPes = {
	pid: number;
	firstPacketIndex: number;
	packetCount: number;
	streamId: number;
	pesPacketLength: number;
	dataAlignment: boolean;
	pts: number | null;
	dts: number | null;
	ptsMarker: number | null;
	dtsMarker: number | null;
	markerBitsOk: boolean;
	headerDataLength: number;
	data: Uint8Array;
	randomAccess: boolean;
	discontinuity: boolean;
};

export type ParsedSection = {
	pid: number;
	tableId: number;
	tableIdExtension: number;
	version: number;
	currentNext: number;
	sectionNumber: number;
	lastSectionNumber: number;
	body: Uint8Array;
	crcOk: boolean;
};

export type ParsedPmt = {
	programNumber: number;
	pcrPid: number;
	programDescriptors: Uint8Array;
	streams: { streamType: number; pid: number; descriptors: Uint8Array }[];
};

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let crc = n << 24;
		for (let k = 0; k < 8; k++) {
			crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
		}
		table[n] = crc >>> 0;
	}
	return table;
})();

const crc32 = (data: Uint8Array) => {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = ((crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ byte]!) >>> 0;
	}
	return crc;
};

export const parseTsPackets = (bytes: Uint8Array): ParsedTsPacket[] => {
	if (bytes.length % 188 !== 0) {
		throw new Error(`Stream length ${bytes.length} is not a multiple of 188.`);
	}

	const packets: ParsedTsPacket[] = [];
	for (let i = 0; i < bytes.length / 188; i++) {
		const packet = bytes.subarray(188 * i, 188 * (i + 1));
		if (packet[0] !== 0x47) {
			throw new Error(`Packet ${i} has no sync byte.`);
		}

		const adaptationFieldControl = (packet[3]! >> 4) & 0x3;
		let offset = 4;
		let adaptation: ParsedTsPacket['adaptation'] = null;

		if (adaptationFieldControl & 0b10) {
			const length = packet[4]!;
			const maxLength = adaptationFieldControl === 0b10 ? 183 : 182;
			if (length > maxLength || (adaptationFieldControl === 0b10 && length !== 183)) {
				throw new Error(`Packet ${i} has an invalid adaptation_field_length of ${length}.`);
			}

			adaptation = { length, discontinuity: false, randomAccess: false, pcr: null, stuffingBytes: [] };
			if (length > 0) {
				const flags = packet[5]!;
				adaptation.discontinuity = !!(flags & 0x80);
				adaptation.randomAccess = !!(flags & 0x40);
				let fieldOffset = 6;
				if (flags & 0x10) {
					adaptation.pcr = packet[6]! * 2 ** 25 + (packet[7]! << 17) + (packet[8]! << 9) + (packet[9]! << 1)
						+ (packet[10]! >> 7);
					fieldOffset += 6;
				}
				if (flags & 0x0f) {
					throw new Error(`Packet ${i} uses adaptation field features this parser doesn't handle.`);
				}
				adaptation.stuffingBytes = [...packet.subarray(fieldOffset, 5 + length)];
			}

			offset = 5 + length;
		}

		packets.push({
			index: i,
			pid: ((packet[1]! & 0x1f) << 8) | packet[2]!,
			payloadUnitStart: !!(packet[1]! & 0x40),
			transportErrorIndicator: !!(packet[1]! & 0x80),
			scramblingControl: packet[3]! >> 6,
			adaptationFieldControl,
			continuityCounter: packet[3]! & 0xf,
			adaptation,
			payload: adaptationFieldControl & 0b01 ? packet.subarray(offset) : new Uint8Array(0),
		});
	}

	return packets;
};

/** Returns a description of every continuity_counter violation (per PID, counting only packets with payload). */
export const findContinuityErrors = (packets: ParsedTsPacket[]) => {
	const errors: string[] = [];
	const last = new Map<number, number>();
	for (const packet of packets) {
		if (packet.pid === 0x1fff) {
			continue;
		}

		const previous = last.get(packet.pid);
		const hasPayload = !!(packet.adaptationFieldControl & 0b01);
		if (previous !== undefined) {
			const expected = hasPayload ? (previous + 1) & 0xf : previous;
			if (packet.continuityCounter !== expected) {
				const counter = packet.continuityCounter;
				errors.push(`PID ${packet.pid} packet ${packet.index}: CC ${counter}, expected ${expected}`);
			}
		}
		last.set(packet.pid, packet.continuityCounter);
	}
	return errors;
};

/** Reassembles PSI sections on a PID (pointer_field honored, one or more sections per payload unit). */
export const parseSections = (packets: ParsedTsPacket[], pid: number): ParsedSection[] => {
	const sections: ParsedSection[] = [];
	let buffer: number[] | null = null;

	const flush = () => {
		if (!buffer) {
			return;
		}

		let offset = 0;
		while (offset + 3 <= buffer.length && buffer[offset] !== 0xff) {
			const sectionLength = ((buffer[offset + 1]! & 0x0f) << 8) | buffer[offset + 2]!;
			const section = Uint8Array.from(buffer.slice(offset, offset + 3 + sectionLength));
			if (section.length < 3 + sectionLength) {
				break;
			}

			sections.push({
				pid,
				tableId: section[0]!,
				tableIdExtension: (section[3]! << 8) | section[4]!,
				version: (section[5]! >> 1) & 0x1f,
				currentNext: section[5]! & 1,
				sectionNumber: section[6]!,
				lastSectionNumber: section[7]!,
				body: section.subarray(8, section.length - 4),
				crcOk: crc32(section) === 0,
			});
			offset += 3 + sectionLength;
		}
		buffer = null;
	};

	for (const packet of packets) {
		if (packet.pid !== pid || packet.payload.length === 0) {
			continue;
		}

		if (packet.payloadUnitStart) {
			const pointerField = packet.payload[0]!;
			if (buffer) {
				buffer.push(...packet.payload.subarray(1, 1 + pointerField));
			}
			flush();
			buffer = [...packet.payload.subarray(1 + pointerField)];
		} else if (buffer) {
			buffer.push(...packet.payload);
		}
	}
	flush();

	return sections;
};

export const parsePat = (section: ParsedSection) => {
	const programs: { programNumber: number; pid: number }[] = [];
	for (let i = 0; i + 4 <= section.body.length; i += 4) {
		programs.push({
			programNumber: (section.body[i]! << 8) | section.body[i + 1]!,
			pid: ((section.body[i + 2]! & 0x1f) << 8) | section.body[i + 3]!,
		});
	}
	return programs;
};

export const parsePmt = (section: ParsedSection): ParsedPmt => {
	const body = section.body;
	const programInfoLength = ((body[2]! & 0x0f) << 8) | body[3]!;
	const pmt: ParsedPmt = {
		programNumber: section.tableIdExtension,
		pcrPid: ((body[0]! & 0x1f) << 8) | body[1]!,
		programDescriptors: body.subarray(4, 4 + programInfoLength),
		streams: [],
	};

	let offset = 4 + programInfoLength;
	while (offset + 5 <= body.length) {
		const esInfoLength = ((body[offset + 3]! & 0x0f) << 8) | body[offset + 4]!;
		pmt.streams.push({
			streamType: body[offset]!,
			pid: ((body[offset + 1]! & 0x1f) << 8) | body[offset + 2]!,
			descriptors: body.subarray(offset + 5, offset + 5 + esInfoLength),
		});
		offset += 5 + esInfoLength;
	}

	return pmt;
};

const readTimestamp = (bytes: Uint8Array, offset: number) => {
	const value = ((bytes[offset]! >> 1) & 0x7) * 2 ** 30
		+ ((bytes[offset + 1]! << 7) | (bytes[offset + 2]! >> 1)) * 2 ** 15
		+ ((bytes[offset + 3]! << 7) | (bytes[offset + 4]! >> 1));
	const markerBitsOk = (bytes[offset]! & 1) === 1 && (bytes[offset + 2]! & 1) === 1 && (bytes[offset + 4]! & 1) === 1;
	return { value, marker: bytes[offset]! >> 4, markerBitsOk };
};

/** Reassembles the PES packets of a PID. */
export const parsePesPackets = (packets: ParsedTsPacket[], pid: number): ParsedPes[] => {
	const result: ParsedPes[] = [];
	let current: { first: ParsedTsPacket; chunks: Uint8Array[]; count: number } | null = null;

	const flush = () => {
		if (!current) {
			return;
		}

		const length = current.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of current.chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}

		if (bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1) {
			throw new Error(`PES packet at TS packet ${current.first.index} lacks a start code prefix.`);
		}
		if ((bytes[6]! >> 6) !== 0b10) {
			throw new Error(`PES packet at TS packet ${current.first.index} lacks the '10' marker.`);
		}

		const pesPacketLength = (bytes[4]! << 8) | bytes[5]!;
		const ptsDtsFlags = bytes[7]! >> 6;
		const headerDataLength = bytes[8]!;
		const pts = ptsDtsFlags & 0b10 ? readTimestamp(bytes, 9) : null;
		const dts = ptsDtsFlags === 0b11 ? readTimestamp(bytes, 14) : null;
		const dataEnd = pesPacketLength === 0 ? bytes.length : 6 + pesPacketLength;

		result.push({
			pid,
			firstPacketIndex: current.first.index,
			packetCount: current.count,
			streamId: bytes[3]!,
			pesPacketLength,
			dataAlignment: !!(bytes[6]! & 0x04),
			pts: pts?.value ?? null,
			dts: dts?.value ?? null,
			ptsMarker: pts?.marker ?? null,
			dtsMarker: dts?.marker ?? null,
			markerBitsOk: (pts?.markerBitsOk ?? true) && (dts?.markerBitsOk ?? true),
			headerDataLength,
			data: bytes.subarray(9 + headerDataLength, dataEnd),
			randomAccess: current.first.adaptation?.randomAccess ?? false,
			discontinuity: current.first.adaptation?.discontinuity ?? false,
		});
		current = null;
	};

	for (const packet of packets) {
		if (packet.pid !== pid) {
			continue;
		}

		if (packet.payloadUnitStart) {
			flush();
			current = { first: packet, chunks: [], count: 0 };
		}

		if (current) {
			current.chunks.push(packet.payload);
			current.count++;
		}
	}
	flush();

	return result;
};

/** Splits Annex B data into NAL units (without start codes). */
export const splitAnnexB = (data: Uint8Array) => {
	const nalUnits: Uint8Array[] = [];
	let start = -1;
	for (let i = 0; i + 2 < data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
			if (start >= 0) {
				let end = i;
				while (end > start && data[end - 1] === 0) {
					end--;
				}
				nalUnits.push(data.subarray(start, end));
			}
			start = i + 3;
			i += 2;
		}
	}
	if (start >= 0) {
		nalUnits.push(data.subarray(start));
	}
	return nalUnits;
};
