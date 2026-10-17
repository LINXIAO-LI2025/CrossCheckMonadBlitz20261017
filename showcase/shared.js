/* Generated from ../protocol.ts. Full report validation and exact-text fingerprints. */
(()=>{
const {isAddress,keccak256,toUtf8Bytes,ZeroAddress}=window.ethers;
/** Shared report format. A matching fingerprint proves integrity, not truth. */
const HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const VERDICTS = new Set(['credible', 'questionable', 'not_credible', 'unable_to_determine']);
function validUnicode(value) {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                return false;
        }
        else if (code >= 0xdc00 && code <= 0xdfff)
            return false;
    }
    return true;
}
/** RFC 8785 JSON subset: recursive UTF-16 key ordering and ECMAScript numbers.
 * Reject non-JSON values, cycles and lone surrogates instead of silently losing data.
 */
function canonicalize(value) {
    const ancestors = new Set();
    const visit = (item) => {
        if (item === null)
            return 'null';
        if (typeof item === 'string') {
            if (!validUnicode(item))
                throw new TypeError('JSON contains an invalid Unicode surrogate');
            return JSON.stringify(item);
        }
        if (typeof item === 'boolean')
            return String(item);
        if (typeof item === 'number') {
            if (!Number.isFinite(item))
                throw new TypeError('JSON numbers must be finite');
            return JSON.stringify(item);
        }
        if (typeof item !== 'object')
            throw new TypeError('Unsupported JSON value');
        if (ancestors.has(item))
            throw new TypeError('JSON contains a cycle');
        ancestors.add(item);
        try {
            if (Array.isArray(item)) {
                const values = [];
                for (let i = 0; i < item.length; i++) {
                    if (!Object.prototype.hasOwnProperty.call(item, i))
                        throw new TypeError('Sparse JSON array');
                    values.push(visit(item[i]));
                }
                return '[' + values.join(',') + ']';
            }
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== Object.prototype && prototype !== null)
                throw new TypeError('Expected plain JSON object');
            if (Object.getOwnPropertySymbols(item).length)
                throw new TypeError('Symbol JSON keys are unsupported');
            const object = item;
            return '{' + Object.keys(object).sort().map(key => {
                if (!validUnicode(key))
                    throw new TypeError('Invalid Unicode JSON key');
                const descriptor = Object.getOwnPropertyDescriptor(object, key);
                if (!('value' in descriptor))
                    throw new TypeError('JSON accessors are unsupported');
                return JSON.stringify(key) + ':' + visit(descriptor.value);
            }).join(',') + '}';
        }
        finally {
            ancestors.delete(item);
        }
    };
    return visit(value);
}
/** Hash the exact submitted text, including leading/trailing whitespace. */
function hashContent(text) {
    if (typeof text !== 'string' || !validUnicode(text))
        throw new TypeError('Expected valid Unicode text');
    return keccak256(toUtf8Bytes(text));
}
function canonicalizePayload(payload) { return canonicalize(payload); }
function hashPayload(payload) { return keccak256(toUtf8Bytes(canonicalizePayload(payload))); }
function deriveAgreement(models) {
    if (models.length !== 2 || models.some(model => !model || model.status !== 'succeeded' ||
        !model.verdict || model.verdict === 'unable_to_determine' || !VERDICTS.has(model.verdict)))
        return 2;
    return models[0].verdict === models[1].verdict ? 0 : 1;
}
function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
        return false;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
        return false;
    const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = '') => '.' + fraction.padEnd(3, '0') + 'Z');
    return date.toISOString() === normalized;
}
function keys(value, expected, prefix, errors) {
    for (const key of expected)
        if (!Object.prototype.hasOwnProperty.call(value, key))
            errors.push(`${prefix}.${key} 缺失`);
    for (const key of Object.keys(value))
        if (!expected.includes(key))
            errors.push(`${prefix}.${key} 未定义`);
}
/** Shape/semantics only. On-chain verification additionally requires compareCertificate. */
function validateReportEnvelope(envelope) {
    const errors = [];
    if (!object(envelope))
        return { valid: false, errors: ['报告必须是 JSON 对象'] };
    keys(envelope, ['payload', 'proof'], 'report', errors);
    if (!object(envelope.payload))
        return { valid: false, errors: [...errors, '缺少有效 payload'] };
    const payload = envelope.payload;
    keys(payload, ['schema_version', 'job_id', 'mode', 'raw_text', 'submitted_at', 'completed_at', 'rule_version', 'prompt_hash', 'model_config_hash', 'models', 'agreement'], 'payload', errors);
    if (payload.schema_version !== '1')
        errors.push('schema_version 必须是 "1"');
    for (const key of ['job_id', 'rule_version'])
        if (!nonempty(payload[key]))
            errors.push(`${key} 必须是非空字符串`);
    if (payload.mode !== 'live' && payload.mode !== 'demo')
        errors.push('mode 必须是 live 或 demo');
    if (!nonempty(payload.raw_text))
        errors.push('raw_text 必须是非空字符串');
    for (const key of ['prompt_hash', 'model_config_hash'])
        if (typeof payload[key] !== 'string' || !HASH.test(payload[key]))
            errors.push(`${key} 必须是 bytes32 哈希`);
    for (const key of ['submitted_at', 'completed_at'])
        if (!timestamp(payload[key]))
            errors.push(`${key} 必须是有效 UTC ISO 时间`);
    if (timestamp(payload.submitted_at) && timestamp(payload.completed_at) && Date.parse(payload.completed_at) < Date.parse(payload.submitted_at))
        errors.push('completed_at 不能早于 submitted_at');
    if (!Array.isArray(payload.models) || payload.models.length !== 2) {
        errors.push('models 必须恰好包含两个模型结果');
    }
    else {
        const slots = new Set();
        payload.models.forEach((model, index) => {
            const prefix = `models[${index}]`;
            if (!object(model)) {
                errors.push(`${prefix} 必须是对象`);
                return;
            }
            keys(model, ['slot', 'provider', 'requested_model', 'returned_model', 'status', 'verdict', 'reason', 'error_code'], prefix, errors);
            if (model.slot !== 'a' && model.slot !== 'b')
                errors.push(`${prefix}.slot 必须是 a 或 b`);
            slots.add(model.slot);
            for (const key of ['provider', 'requested_model'])
                if (!nonempty(model[key]))
                    errors.push(`${prefix}.${key} 必须是非空字符串`);
            if (model.returned_model !== null && !nonempty(model.returned_model))
                errors.push(`${prefix}.returned_model 必须是字符串或 null`);
            if (model.status === 'succeeded') {
                if (!nonempty(model.returned_model))
                    errors.push(`${prefix} 成功结果必须包含返回模型名`);
                if (typeof model.verdict !== 'string' || !VERDICTS.has(model.verdict))
                    errors.push(`${prefix}.verdict 无效`);
                if (!nonempty(model.reason))
                    errors.push(`${prefix} 成功结果必须包含理由`);
                if (model.error_code !== null)
                    errors.push(`${prefix} 成功结果的 error_code 必须为 null`);
            }
            else if (model.status === 'failed') {
                if (model.verdict !== null || model.reason !== null)
                    errors.push(`${prefix} 失败结果不得包含判断与理由`);
                if (!nonempty(model.error_code))
                    errors.push(`${prefix} 失败结果必须包含 error_code`);
            }
            else
                errors.push(`${prefix}.status 无效`);
        });
        if (!slots.has('a') || !slots.has('b') || slots.size !== 2)
            errors.push('models 必须分别包含 a、b 槽位');
        if (payload.agreement !== deriveAgreement(payload.models))
            errors.push('agreement 与模型结果不符');
    }
    if (payload.agreement !== 0 && payload.agreement !== 1 && payload.agreement !== 2)
        errors.push('agreement 必须是整数 0、1 或 2');
    if (envelope.proof !== null) {
        if (!object(envelope.proof))
            errors.push('proof 必须是对象或 null');
        else {
            const proof = envelope.proof;
            keys(proof, ['chain_id', 'contract_address', 'certificate_id', 'issuer', 'tx_hash', 'block_number', 'block_time'], 'proof', errors);
            if (proof.chain_id !== 10143 && proof.chain_id !== 31337)
                errors.push('proof.chain_id 必须是受支持测试链');
            for (const key of ['contract_address', 'issuer'])
                if (typeof proof[key] !== 'string' || !isAddress(proof[key]) || proof[key].toLowerCase() === ZeroAddress)
                    errors.push(`proof.${key} 地址无效`);
            if (typeof proof.tx_hash !== 'string' || !HASH.test(proof.tx_hash))
                errors.push('proof.tx_hash 无效');
            for (const key of ['certificate_id', 'block_number', 'block_time'])
                if (typeof proof[key] !== 'string' || !UINT.test(proof[key]))
                    errors.push(`proof.${key} 必须是十进制整数字符串`);
            if (proof.certificate_id === '0')
                errors.push('certificate_id 必须大于 0');
        }
    }
    try {
        canonicalize(envelope);
    }
    catch (error) {
        errors.push(error instanceof Error ? error.message : '无效 JSON');
    }
    return { valid: errors.length === 0, errors };
}
function computeHashes(payload) {
    return { content_hash: hashContent(payload.raw_text), verdict_hash: hashPayload(payload) };
}
/** Compare every identity field, both hashes and independently derived agreement. */
function compareCertificate(envelope, record) {
    const result = validateReportEnvelope(envelope);
    if (!result.valid)
        return result;
    const errors = [];
    if (!envelope.proof)
        return { valid: false, errors: ['报告尚未存证'] };
    const hashes = computeHashes(envelope.payload);
    if (hashes.content_hash.toLowerCase() !== record.content_hash.toLowerCase())
        errors.push('原文哈希与链上记录不符');
    if (hashes.verdict_hash.toLowerCase() !== record.verdict_hash.toLowerCase())
        errors.push('报告哈希与链上记录不符');
    if (envelope.payload.agreement !== record.agreement)
        errors.push('agreement 与链上记录不符');
    for (const key of ['chain_id', 'certificate_id', 'block_number', 'block_time'])
        if (envelope.proof[key] !== record.proof[key])
            errors.push(`proof.${key} 与链上记录不符`);
    for (const key of ['contract_address', 'issuer', 'tx_hash'])
        if (envelope.proof[key].toLowerCase() !== record.proof[key].toLowerCase())
            errors.push(`proof.${key} 与链上记录不符`);
    return { valid: errors.length === 0, errors };
}

window.ShowcaseProtocol={canonicalize,computeHashes,validateReportEnvelope,deriveAgreement,compareCertificate};
})();
