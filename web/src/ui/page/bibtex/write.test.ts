import { describe, expect, it } from 'vitest'
import { parseBibtex } from './parse'
import { baseKey, bibtexName, escapeText, escapeTitle, splitAuthors, toBibtex } from './write'
import type { BibSource } from './write'

const src = (extra: Partial<BibSource>): BibSource => ({ title: '', authors: '', year: '', doi: '', url: '', note: '', ...extra })

describe('toBibtex', () => {
  it('writes @article for a DOI and @misc otherwise, fields aligned', () => {
    const text = toBibtex([
      src({ title: 'Scheme for reducing decoherence', authors: 'P. W. Shor', year: '1995', doi: '10.1103/PhysRevA.52.R2493' }),
      src({ title: 'Parametrized quantum policies', authors: 'S. Jerbi, V. Dunjko', year: '2021', url: 'https://arxiv.org/abs/2103.05577' }),
    ])
    expect(text).toBe(`@article{shor1995scheme,
  title  = {Scheme for reducing decoherence},
  author = {Shor, P. W.},
  year   = {1995},
  doi    = {10.1103/PhysRevA.52.R2493}
}

@misc{jerbi2021parametrized,
  title         = {Parametrized quantum policies},
  author        = {Jerbi, S. and Dunjko, V.},
  year          = {2021},
  url           = {https://arxiv.org/abs/2103.05577},
  eprint        = {2103.05577},
  archiveprefix = {arXiv}
}
`)
  })

  it('writes nothing for no Sources, and a bare entry for an empty one', () => {
    expect(toBibtex([])).toBe('')
    expect(toBibtex([src({})])).toBe('@misc{source\n}\n')
  })

  it('makes keys unique with letters', () => {
    const same = src({ title: 'On the theory', authors: 'Ana Ruiz', year: '2020' })
    const keys = [...toBibtex([same, same, same, src({ authors: 'Ana Ruiz', year: '2020', title: 'Theory again' })]).matchAll(/^@\w+\{([^,\n]+)/gm)].map(
      (m) => m[1],
    )
    expect(keys).toEqual(['ruiz2020theory', 'ruiz2020theorya', 'ruiz2020theoryb', 'ruiz2020theoryc'])
  })

  it('builds keys from plain letters, skipping small words', () => {
    expect(baseKey({ authors: 'José Müller-Šťastný', year: '2019', title: 'A Über-fast décoder' })).toBe('mullerstastny2019uber')
    expect(baseKey({ authors: 'Jerbi, S.; Dunjko, V.', year: 'c. 2021', title: '' })).toBe('jerbi2021')
    expect(baseKey({ authors: '', year: '', title: 'The $\\alpha$ problem' })).toBe('sourcealpha')
  })

  it('escapes what BibTeX and LaTeX would read differently', () => {
    expect(escapeText('50% & $5 #1 a_b ~ ^ back\\slash')).toBe('50\\% \\& \\$5 \\#1 a\\_b \\textasciitilde{} \\textasciicircum{} back\\textbackslash{}slash')
    expect(escapeText('pairs {kept} but } lone {')).toBe('pairs \\{kept\\} but \\textbraceright{} lone \\textbraceleft{}')
    expect(escapeText('Bounds for $\\mathrm{SU}(2)$')).toBe('Bounds for $\\mathrm{SU}(2)$')
    expect(escapeText('  many\n  spaces ')).toBe('many spaces')
  })

  it('writes "and others" for et al.', () => {
    expect(splitAuthors('S. Jerbi et al.')).toEqual({ names: ['S. Jerbi'], others: true })
    expect(toBibtex([src({ authors: 'S. Jerbi, V. Dunjko, et al.' })])).toContain('author = {Jerbi, S. and Dunjko, V. and others}')
  })

  it('writes "Family, Given", particles with the family name', () => {
    expect(bibtexName('Albert Einstein')).toBe('Einstein, Albert')
    expect(bibtexName('John von Neumann')).toBe('von Neumann, John')
    expect(bibtexName('Ludwig van der Waals')).toBe('van der Waals, Ludwig')
    expect(bibtexName('Jerbi, S.')).toBe('Jerbi, S.')
    expect(bibtexName('Plato')).toBe('Plato')
  })

  it('splits the Authors field however it was written', () => {
    expect(splitAuthors('S. Jerbi, V. Dunjko').names).toEqual(['S. Jerbi', 'V. Dunjko'])
    expect(splitAuthors('Jerbi, S.; Dunjko, V.').names).toEqual(['Jerbi, S.', 'Dunjko, V.'])
    expect(splitAuthors('A. One, B. Two and C. Three').names).toEqual(['A. One', 'B. Two', 'C. Three'])
  })

  it('keeps an address as it is, apart from braces and spaces', () => {
    expect(toBibtex([src({ url: 'https://example.org/~me/a_b?x=1&y=%20#top' })])).toContain('url = {https://example.org/~me/a_b?x=1&y=%20#top}')
    expect(toBibtex([src({ url: 'https://example.org/{x} y' })])).toContain('url = {https://example.org/%7Bx%7D%20y}')
  })
})

describe('escapeTitle: case kept through bibliography styles', () => {
  it('braces proper nouns, acronyms and capitalised words, but not the first letter of the title', () => {
    expect(escapeTitle('Observation of a new particle in the search for the Standard Model Higgs boson with the ATLAS detector at the LHC')).toBe(
      'Observation of a new particle in the search for the {Standard} {Model} {Higgs} boson with the {ATLAS} detector at the {LHC}',
    )
    expect(escapeTitle('Quantum machine learning in feature Hilbert spaces')).toBe('Quantum machine learning in feature {Hilbert} spaces')
    expect(escapeTitle('Parametrized quantum policies for reinforcement learning')).toBe('Parametrized quantum policies for reinforcement learning')
  })

  it('braces mixed case, a capital after the first letter of the first word, and words after a colon', () => {
    expect(escapeTitle('Measuring the pH dependence of mRNA decay in E. coli')).toBe('Measuring the {pH} dependence of {mRNA} decay in {E}. coli')
    expect(escapeTitle('SU(2) lattice gauge theory: A review')).toBe('{SU(2)} lattice gauge theory: {A} review')
    expect(escapeTitle('NISQ algorithms: Variational methods for near-term devices')).toBe('{NISQ} algorithms: {Variational} methods for near-term devices')
    expect(escapeTitle('iPhone sensors as seismometers')).toBe('{iPhone} sensors as seismometers')
    expect(escapeTitle('“Quantum” supremacy using a programmable superconducting processor')).toBe('“Quantum” supremacy using a programmable superconducting processor')
    // The first letter of the title stays a capital in every style, so a proper noun there needs no braces.
    expect(escapeTitle('Schrödinger’s cat states in Bose–Einstein condensates')).toBe('Schrödinger’s cat states in {Bose–Einstein} condensates')
  })

  it('keeps punctuation around a word outside its braces', () => {
    expect(escapeTitle('Results from the LHC: (CMS), “Higgs” and SU(2).')).toBe('Results from the {LHC}: ({CMS}), “{Higgs}” and {SU(2)}.')
  })

  it('leaves math as written and braces the words around it', () => {
    expect(escapeTitle('Lower bounds for $\\mathrm{SU}(2)$ Yang–Mills theory')).toBe('Lower bounds for $\\mathrm{SU}(2)$ {Yang–Mills} theory')
    expect(escapeTitle('$\\alpha$-Decay of Heavy nuclei')).toBe('$\\alpha${-Decay} of {Heavy} nuclei')
    expect(escapeTitle('The $\\Lambda$CDM model')).toBe('The $\\Lambda${CDM} model')
  })

  it('keeps escapes right inside braced words, and never braces a word twice', () => {
    expect(escapeTitle('Lessons from AT&T Bell Labs at 50%')).toBe('Lessons from {AT\\&T} {Bell} {Labs} at 50\\%')
    // A group that opens with a backslash is a special character to BibTeX, which still changes its letters.
    expect(escapeTitle('Smith &Co reports')).toBe('Smith {{\\&Co}} reports')
    expect(escapeTitle('Already {QCD Sum} rules')).toBe('Already \\{QCD Sum\\} rules')
    expect(escapeTitle('Field theory {Lattice}')).toBe('Field theory \\{Lattice\\}')
  })

  it('is what toBibtex writes for a title, and only for the title', () => {
    expect(toBibtex([src({ title: 'Entanglement in CFT', note: 'Talk at CERN' })])).toBe('@misc{sourceentanglement,\n  title = {Entanglement in {CFT}},\n  note  = {Talk at CERN}\n}\n')
  })
})

describe('round trip through the importer', () => {
  const awkward: BibSource[] = [
    src({ title: 'Ströme & Wellen: 50% {schneller} — für $\\mathcal{O}(n^2)$', authors: 'Jürgen Groß, Åsa Ødegård', year: '2018', doi: '10.1000/a_b', note: 'see p. #3 ~ ok' }),
    src({ title: 'Back\\slash, ^carets^ and } a lone brace', authors: 'Ana Ruiz, et al.', year: '2024', url: 'https://example.org/~x/y_z?q=1&r=2' }),
    src({ title: 'Data re-uploading', authors: 'A. Pérez-Salinas, A. Cervera-Lierta', year: '2020', url: 'https://arxiv.org/abs/1907.02085v2' }),
    src({ title: 'Data re-uploading', authors: 'A. Pérez-Salinas, A. Cervera-Lierta', year: '2020' }),
    src({ title: 'Observation of the Higgs boson with ATLAS: A 5σ excess at 125 GeV', authors: 'G. Aad', year: '2012', doi: '10.1016/j.physletb.2012.08.020' }),
    src({ title: 'pH-dependent mRNA decay in E. coli & Lessons from AT&T', authors: 'B. Ng', year: '2019' }),
    src({ title: 'Bounds for $\\mathrm{SU}(2)$ Yang–Mills: the $\\Lambda$CDM {Already Braced} case', authors: 'C. Lee', year: '2022' }),
    src({ title: 'Smith &Co, iPhone and Schrödinger’s Cat', authors: 'D. Kim', year: '2023' }),
  ]

  it('reads back exactly what was written', () => {
    const { entries, problems } = parseBibtex(toBibtex(awkward))
    expect(problems).toEqual([])
    expect(entries.map(({ title, authors, year, doi, url, note }) => ({ title, authors, year, doi, url, note }))).toEqual(awkward)
    expect(new Set(entries.map((e) => e.key)).size).toBe(awkward.length)
  })
})
