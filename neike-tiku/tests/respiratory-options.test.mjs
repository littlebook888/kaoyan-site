import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const payload = JSON.parse(await readFile(new URL('../src/data/med-data.json', import.meta.url), 'utf8'))
const groups = payload.groups.filter((group) => group.topic === '呼吸')
const byId = new Map(groups.map((group) => [group.id, group]))

const label = (groupId, key) => {
  const option = byId.get(groupId)?.options.find((item) => item.key === key)
  assert.ok(option, `${groupId} missing option ${key}`)
  return option.label
}

test('respiratory option banks have unique keys and valid answers', () => {
  assert.equal(groups.length, 43)
  for (const group of groups) {
    const keys = group.options.map((option) => option.key)
    assert.equal(new Set(keys).size, keys.length, `${group.id} has duplicate option keys`)
    for (const [index, stem] of group.stems.entries()) {
      for (const answer of stem.answer) {
        assert.ok(keys.includes(answer), `${group.id} stem ${index + 1} references missing ${answer}`)
      }
    }
  }
})

test('options previously truncated or misread match the source pages and lectures', () => {
  assert.equal(label('p05-g1', 'H'), '休克：收缩压<90mmHg、收缩压降低≥40mmHg，或心搏骤停')
  assert.equal(label('p06-g2', 'G'), '头孢他啶/哌酮/吡肟等三、四代头孢')
  assert.equal(label('p07-g1', 'A'), '多无咯血和杵状指')
  assert.match(label('p07-g4', 'A'), /^在医院外发生的肺炎/)
  assert.match(label('p07-g4', 'K'), />48小时后/)
  assert.equal(label('p08-g2', '②'), '叶间隙下坠、蜂窝状脓肿')
  assert.match(label('p08-g2', '⑧'), /沿支气管\/肺纹理/)
  assert.equal(label('p08-g2', '⑨'), '大片实变及明显胸腔积液少见')
  assert.match(label('p08-g3', 'D'), /头孢噻肟/)
  assert.match(label('p08-g3', 'E'), /氨基糖苷类（阿米卡星\/妥布霉素）/)
  assert.equal(label('p08-g4', 'D'), '双肺下叶和背侧')
  assert.match(label('p12-g2', 'B'), /气管-食管瘘$/)
  assert.equal(label('p12-g2', 'V'), '膈神经→呃逆')
  assert.equal(label('p15-g2', 'O'), '血管通透性↑→药物过敏')
  assert.equal(label('p16-g1', 'E'), '细胞计数>500×10^6/L')
  assert.equal(label('p18-g1', 'H'), '细胞>500×10^6/L')
  assert.equal(label('p18-g1', 'I'), '胸水细胞可>10×10^9/L')
})

test('known OCR fragments no longer appear in respiratory option labels', () => {
  const labels = groups.flatMap((group) => group.options.map((option) => option.label)).join('\n')
  for (const fragment of ['降低z40', '头孢喹诺', '双肺中叶和背侧', '气管-食管痿', '膈神经→呕逆', '血管通透性个']) {
    assert.ok(!labels.includes(fragment), `stale OCR fragment remains: ${fragment}`)
  }
})
