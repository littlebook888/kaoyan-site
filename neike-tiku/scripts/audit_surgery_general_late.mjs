import fs from 'node:fs'
import { surgeryGeneralInfectionGroups, surgeryGeneralLaterGroups } from '../src/data/surgery-general-late-data.js'

const groups = [...surgeryGeneralInfectionGroups, ...surgeryGeneralLaterGroups]
const errors = []
const choiceGroups = groups.filter((group) => group.kind === 'B')
const fillGroups = groups.filter((group) => group.kind === 'FILL')
const stems = groups.flatMap((group) => group.stems)

if (groups.length !== 33) errors.push(`题组数应为33，实际${groups.length}`)
if (choiceGroups.length !== 29) errors.push(`选择题组应为29，实际${choiceGroups.length}`)
if (fillGroups.length !== 4) errors.push(`填空题组应为4，实际${fillGroups.length}`)
if (stems.length !== 141) errors.push(`题干数应为141，实际${stems.length}`)

const ids = new Set()
for (const group of groups) {
  if (ids.has(group.id)) errors.push(`重复题组ID：${group.id}`)
  ids.add(group.id)
  if (!group.title || !group.lectureEvidence?.image) errors.push(`${group.id} 缺标题或讲义证据`)
  if (group.topic !== '外科总论') errors.push(`${group.id} 章节归属错误`)

  const optionKeys = new Set(group.options.map((option) => option.key))
  if (group.kind === 'B') {
    if (group.options.length < 2) errors.push(`${group.id} 选项不足`)
    if (new Set(group.options.map((option) => option.sourceKey)).size !== group.options.length) errors.push(`${group.id} 原始选项键重复`)
    if (group.options.every((option, index) => option.sourceKey === group.optionOriginalOrder[index])) errors.push(`${group.id} 选项未打乱`)
  }
  for (const stem of group.stems) {
    if (!stem.text.trim()) errors.push(`${group.id} 存在空题干`)
    if (!Array.isArray(stem.answer) || stem.answer.length === 0) errors.push(`${group.id} 存在空答案`)
    if (group.kind === 'B' && stem.answer.some((key) => !optionKeys.has(key))) errors.push(`${group.id} 答案指向不存在的选项`)
    if (group.kind === 'FILL' && (stem.text.match(/____/g) || []).length !== stem.answer.length) errors.push(`${group.id} 填空数与答案数不一致：${stem.text}`)
  }
}

if (Math.max(...choiceGroups.map((group) => group.options.length)) !== 33) errors.push('最长选项池应为33项')

const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const infectionMarker = appSource.includes('...surgeryGeneralLateContent.surgeryGeneralInfectionGroups')
  ? '...surgeryGeneralLateContent.surgeryGeneralInfectionGroups'
  : '...surgeryGeneralInfectionGroups'
const laterMarker = appSource.includes('...surgeryGeneralLateContent.surgeryGeneralLaterGroups')
  ? '...surgeryGeneralLateContent.surgeryGeneralLaterGroups'
  : '...surgeryGeneralLaterGroups'
const orderedInsertion = appSource.indexOf('...surgeryGeneralCoreContent.groups') < appSource.indexOf(infectionMarker)
  && appSource.indexOf(infectionMarker) < appSource.indexOf('...surgeryGeneralContent.groups')
  && appSource.indexOf('...surgeryGeneralContent.groups') < appSource.indexOf(laterMarker)
if (!orderedInsertion) errors.push('外科总论讲义顺序应为30～34、35～36、37～38')

const shallow = surgeryGeneralInfectionGroups.find((group) => group.id === 'surgery-general-infection-02')
const sourceAnswerFor = (text) => shallow.stems.find((stem) => stem.text === text).answer.map((key) => shallow.options.find((option) => option.key === key).sourceKey)
for (const key of ['E', 'J']) {
  if (!sourceAnswerFor('疖').includes(key) || sourceAnswerFor('痈').includes(key)) errors.push(`浅部感染讲义修正未落实：${key}`)
}

const byId = new Map(groups.map((group) => [group.id, group]))
for (const retiredMixedId of [
  'surgery-general-infection-01', 'surgery-general-infection-04',
  'surgery-general-shock-01', 'surgery-general-shock-06',
  'surgery-general-other-02', 'surgery-general-other-04', 'surgery-general-other-05', 'surgery-general-other-06',
]) {
  if (byId.has(retiredMixedId)) errors.push(`${retiredMixedId} 混合选项池重新出现`)
}

const expectedSplitAnswers = {
  'surgery-general-infection-01a': ['ACDE', 'G', 'BCF'],
  'surgery-general-infection-01b': ['CE', 'DFM', 'ABGHIJKL', 'N'],
  'surgery-general-infection-04a': ['EGL', 'ACDFH', 'IMN', 'BJK'],
  'surgery-general-infection-04b': ['ABCF', 'DEG'],
  'surgery-general-shock-01a': ['B', 'E', 'ACDF'],
  'surgery-general-shock-01b': ['BF', 'AC', 'DEG'],
  'surgery-general-shock-06a': ['H', 'F', 'B', 'J', 'I', 'EI', 'DI', 'CG', 'A', 'K'],
  'surgery-general-shock-06b': ['A', 'A', 'C', 'AB', 'AE', 'D'],
  'surgery-general-shock-06c': ['AB', 'E', 'C', 'D'],
  'surgery-general-other-02a': ['BC', 'AC', 'D'],
  'surgery-general-other-02b': ['A', 'BEG', 'CDEF'],
  'surgery-general-other-04a': ['AB', 'CD'],
  'surgery-general-other-04b': ['A', 'B'],
  'surgery-general-other-04c': ['A', 'C', 'B'],
  'surgery-general-other-04d': ['AD', 'BC'],
  'surgery-general-other-05a': ['IJK', 'EH', 'DF', 'ABCG'],
  'surgery-general-other-06a': ['CDF', 'AB', 'E'],
  'surgery-general-other-06b': ['ABDF', 'CEG'],
}
for (const [groupId, expected] of Object.entries(expectedSplitAnswers)) {
  const group = byId.get(groupId)
  if (!group) {
    errors.push(`缺少拆分题组：${groupId}`)
    continue
  }
  const currentToSource = Object.fromEntries(group.options.map((option) => [option.key, option.sourceKey]))
  const semantic = group.stems.map((stem) => stem.answer.map((key) => currentToSource[key]).sort().join(''))
  const normalizedExpected = expected.map((answer) => [...answer].sort().join(''))
  if (JSON.stringify(semantic) !== JSON.stringify(normalizedExpected)) errors.push(`${groupId} 拆分后答案映射错误`)
}

const laparoscopy = byId.get('surgery-general-other-05b')
if (laparoscopy?.kind !== 'FILL' || laparoscopy?.stems[0]?.text !== '腹腔镜手术常见并发症与____气腹相关。' || laparoscopy?.stems[0]?.answer[0] !== 'CO₂') {
  errors.push('腹腔镜单知识点未规范为有效填空题')
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}

console.log(`外科总论后续内容审计通过：${groups.length}组，${stems.length}题干；混合选项池已拆分，感染已置于围术期前。`)
