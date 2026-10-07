import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const data = JSON.parse(readFileSync(new URL('../src/data/med-data.json', import.meta.url)))
const group = id => data.groups.find(item => item.id === id)

test('iron deficiency group belongs only to lecture 28', () => {
  const g = group('p43-g1')
  assert.deepEqual(g.lectureIds, ['lecture-28'])
  assert.equal(g.lectureEvidence.lectureId, 'lecture-28')
})

test('acute leukemia regimen group keeps regimen names separate from their components', () => {
  const g = group('p54-g2')
  assert.equal(g.title, '急性白血病的联合化疗')
  assert.deepEqual(g.lectureIds, ['lecture-34'])
  assert.deepEqual(g.options.map(option => [option.key, option.label]), [
    ['A', '伊达比星'],
    ['B', '化疗前用羟基脲、水化进行短期预处理'],
    ['C', '柔红霉素'],
    ['D', '高三尖杉酯碱'],
    ['E', '化疗前用地塞米松、水化进行短期预处理'],
    ['F', 'IA'],
    ['G', '长春新碱'],
    ['H', 'VP'],
    ['I', 'DA'],
    ['J', 'DVP'],
    ['K', '阿糖胞苷'],
    ['L', '泼尼松'],
    ['M', 'HA'],
    ['N', 'DVLP'],
    ['O', '左旋门冬酰胺酶'],
  ])
  assert.deepEqual(g.stems.map(stem => [stem.text, stem.answer.join('')]), [
    ['AML（除M3型）的预处理及联合化疗方案', 'BFIM'],
    ['ALL的预处理及联合化疗方案', 'EHJN'],
    ['IA方案组成', 'AK'],
    ['DA方案组成', 'CK'],
    ['HA方案组成', 'DK'],
    ['VP方案组成', 'GL'],
    ['DVP方案组成', 'CGL'],
    ['DVLP方案组成', 'CGLO'],
    ['只能用于治疗AML', 'D'],
    ['只能用于治疗ALL', 'O'],
  ])
})
