import { describe, expect, it } from 'vitest'
import { latexToText, latexToVerbatim } from './latex'
import { describeProblem, parseBibtex, readAuthors } from './parse'

const ZOTERO = `
@article{jerbi_parametrized_2021,
	title = {Parametrized quantum policies for reinforcement learning},
	volume = {34},
	url = {https://proceedings.neurips.cc/paper/2021/hash/eec96a7f788e88184c0e713456026f3f-Abstract.html},
	urldate = {2024-02-01},
	journal = {Advances in Neural Information Processing Systems},
	author = {Jerbi, Sofiene and Gyurik, Casper and Marshall, Simon and Briegel, Hans and Dunjko, Vedran},
	year = {2021},
	pages = {28362--28375},
	file = {Full Text PDF:/Users/x/Zotero/storage/ABCD/Jerbi.pdf:application/pdf},
}

@article{perez-salinas_data_2020,
	title = {Data re-uploading for a universal quantum classifier},
	volume = {4},
	issn = {2521-327X},
	url = {https://quantum-journal.org/papers/q-2020-02-06-226/},
	doi = {10.22331/q-2020-02-06-226},
	language = {en-GB},
	urldate = {2024-02-01},
	journal = {Quantum},
	author = {Pérez-Salinas, Adrián and Cervera-Lierta, Alba and Gil-Fuster, Elies and Latorre, José I.},
	month = feb,
	year = {2020},
	note = {Publisher: Verein zur Förderung des Open Access Publizierens in den Quantenwissenschaften},
	pages = {226},
}
`

const SCHOLAR = `@article{jerbi2021parametrized,
  title={Parametrized quantum policies for reinforcement learning},
  author={Jerbi, Sofiene and Gyurik, Casper and Marshall, Simon and Briegel, Hans J and Dunjko, Vedran},
  journal={arXiv preprint arXiv:2103.05577},
  year={2021}
}

@inproceedings{schuld2019,
  title={Quantum machine learning in feature {H}ilbert spaces},
  author={Schuld, Maria and Killoran, Nathan},
  booktitle={Physical review letters},
  volume={122},
  number={4},
  pages={040504},
  year={2019},
  organization={APS}
}`

const ARXIV = `@misc{jerbi2021parametrized,
      title={Parametrized Quantum Policies for Reinforcement Learning},
      author={Sofiene Jerbi and Casper Gyurik and Simon Marshall and Hans J. Briegel and Vedran Dunjko},
      year={2021},
      eprint={2103.05577},
      archivePrefix={arXiv},
      primaryClass={quant-ph},
      url={https://arxiv.org/abs/2103.05577},
}`

const JABREF = `% This file was created with JabRef 5.9.
% Encoding: UTF-8

@Article{Barenco1995,
  author    = {Barenco, A. and Bennett, C. H. and Cleve, R. and DiVincenzo, D. P. and Margolus, N. and Shor, P. and Sleator, T. and Smolin, J. A. and Weinfurter, H.},
  journal   = {Phys. Rev. A},
  title     = {Elementary gates for quantum computation},
  year      = {1995},
  doi       = {10.1103/PhysRevA.52.3457},
}

@Comment{jabref-meta: databaseType:bibtex;}
`

const MENDELEY = `@article{Shor1995,
abstract = {In a quantum computer, ... {\\{}braces{\\}} ...},
author = {Shor, Peter W.},
doi = {10.1103/PhysRevA.52.R2493},
file = {:Users/x/Documents/Mendeley Desktop/Shor - 1995.pdf:pdf},
issn = {1050-2947},
journal = {Physical Review A},
mendeley-groups = {QEC},
number = {4},
pages = {R2493--R2496},
title = {{Scheme for reducing decoherence in quantum computer memory}},
url = {https://link.aps.org/doi/10.1103/PhysRevA.52.R2493},
volume = {52},
year = {1995}
}`

describe('parseBibtex: real exports', () => {
  it('reads a Zotero export (tabs, month macro, file field, unicode as is)', () => {
    const { entries, problems } = parseBibtex(ZOTERO)
    expect(problems).toEqual([])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      key: 'jerbi_parametrized_2021',
      type: 'article',
      line: 2,
      title: 'Parametrized quantum policies for reinforcement learning',
      authors: 'Sofiene Jerbi, Casper Gyurik, Simon Marshall, Hans Briegel, Vedran Dunjko',
      year: '2021',
      doi: '',
      url: 'https://proceedings.neurips.cc/paper/2021/hash/eec96a7f788e88184c0e713456026f3f-Abstract.html',
      note: '',
    })
    expect(entries[1]).toMatchObject({
      key: 'perez-salinas_data_2020',
      line: 14,
      authors: 'Adrián Pérez-Salinas, Alba Cervera-Lierta, Elies Gil-Fuster, José I. Latorre',
      doi: '10.22331/q-2020-02-06-226',
      note: 'Publisher: Verein zur Förderung des Open Access Publizierens in den Quantenwissenschaften',
    })
  })

  it('reads a Google Scholar export and finds the arXiv id in the journal', () => {
    const { entries, problems } = parseBibtex(SCHOLAR)
    expect(problems).toEqual([])
    expect(entries.map((e) => e.url)).toEqual(['https://arxiv.org/abs/2103.05577', ''])
    expect(entries[1]).toMatchObject({ type: 'inproceedings', title: 'Quantum machine learning in feature Hilbert spaces', authors: 'Maria Schuld, Nathan Killoran' })
  })

  it('reads an arXiv export (eprint, archivePrefix, trailing comma)', () => {
    const [e] = parseBibtex(ARXIV).entries
    expect(e).toMatchObject({ type: 'misc', year: '2021', url: 'https://arxiv.org/abs/2103.05577' })
    expect(e!.authors).toBe('Sofiene Jerbi, Casper Gyurik, Simon Marshall, Hans J. Briegel, Vedran Dunjko')
  })

  it('takes eprint + archivePrefix when there is no url', () => {
    const [e] = parseBibtex('@misc{x, eprint = {2103.05577}, eprinttype = {arxiv}}').entries
    expect(e!.url).toBe('https://arxiv.org/abs/2103.05577')
  })

  it('reads a JabRef file: comments before, @Comment after, capitalised type', () => {
    const { entries, problems } = parseBibtex(JABREF)
    expect(problems).toEqual([])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: 'article', key: 'Barenco1995', doi: '10.1103/PhysRevA.52.3457', line: 4 })
    expect(entries[0]!.authors.split(', ')).toHaveLength(9)
    expect(entries[0]!.authors.startsWith('A. Barenco, C. H. Bennett')).toBe(true)
  })

  it('reads a Mendeley export (double braces, escaped braces in an unused field)', () => {
    const [e] = parseBibtex(MENDELEY).entries
    expect(e).toMatchObject({
      title: 'Scheme for reducing decoherence in quantum computer memory',
      authors: 'Peter W. Shor',
      doi: '10.1103/PhysRevA.52.R2493',
      url: 'https://link.aps.org/doi/10.1103/PhysRevA.52.R2493',
    })
  })

  it('drops the braces that only protect case, wherever an exporter put them', () => {
    const text = `@article{aad2012,
  title = {Observation of a new particle in the search for the {Standard} {Model} {Higgs} boson with the {ATLAS} detector at the {LHC}},
}
@article{zotero,
	title = {Measuring the {pH} dependence of {mRNA} decay in {E}. coli: {A} {Bose}–{Einstein} view},
}
@article{scholar,
  title={{SU}(2) lattice gauge theory on {IBM} quantum hardware},
}
@article{mendeley,
title = {{Lower bounds for $\\mathrm{SU}(2)$ Yang--Mills theory}},
}
@article{accent,
title = {{\\"{O}}ffene {F}ragen zu {\\v{C}}erenkov radiation},
}`
    const { entries, problems } = parseBibtex(text)
    expect(problems).toEqual([])
    expect(entries.map((e) => e.title)).toEqual([
      'Observation of a new particle in the search for the Standard Model Higgs boson with the ATLAS detector at the LHC',
      'Measuring the pH dependence of mRNA decay in E. coli: A Bose–Einstein view',
      'SU(2) lattice gauge theory on IBM quantum hardware',
      'Lower bounds for $\\mathrm{SU}(2)$ Yang–Mills theory',
      'Öffene Fragen zu Čerenkov radiation',
    ])
  })

  it('accepts CRLF line ends and a byte-order mark', () => {
    const { entries } = parseBibtex('\uFEFF@misc{a,\r\n  title = {One},\r\n}\r\n@misc{b,\r\n title={Two}}')
    expect(entries.map((e) => [e.title, e.line])).toEqual([
      ['One', 1],
      ['Two', 4],
    ])
  })
})

describe('parseBibtex: syntax', () => {
  it('reads quoted values with braces and quotes inside braces', () => {
    const [e] = parseBibtex('@misc{k, title = "The {"}Quoted{"} {Word}s", year = 1999}').entries
    expect(e!.title).toBe('The "Quoted" Words')
    expect(e!.year).toBe('1999')
  })

  it('reads nested braces', () => {
    const [e] = parseBibtex('@misc{k, title = {A {B {C} D} E}}').entries
    expect(e!.title).toBe('A B C D E')
  })

  it('expands @string, joins with #, and knows the months', () => {
    const text = `@string{prl = "Physical Review Letters"}
@STRING(aps = {APS})
@string{both = prl # " (" # aps # ")"}
@misc{k, note = both # ", " # jan, title = {T}}`
    const { entries, problems } = parseBibtex(text)
    expect(problems).toEqual([])
    expect(entries[0]!.note).toBe('Physical Review Letters (APS), January')
  })

  it('reads an undefined abbreviation as nothing, as BibTeX does', () => {
    const [e] = parseBibtex('@misc{k, note = nowhere # {x}}').entries
    expect(e!.note).toBe('x')
  })

  it('reads entries in parentheses', () => {
    const [e] = parseBibtex('@article(k, title = {Round}, year = 2001)').entries
    expect(e).toMatchObject({ key: 'k', title: 'Round', year: '2001' })
  })

  it('skips @comment and @preamble, and text between entries', () => {
    const text = `Some words with an @ sign, like a@b.org.
@preamble{ "\\newcommand{\\noopsort}[1]{}" }
@comment{ @misc{fake, title = {not an entry}} }
@misc{real, title = {Real}}`
    const { entries, problems } = parseBibtex(text)
    expect(problems).toEqual([])
    expect(entries.map((e) => e.key)).toEqual(['real'])
  })

  it('keeps the first of two fields with the same name', () => {
    expect(parseBibtex('@misc{k, title = {First}, title = {Second}}').entries[0]!.title).toBe('First')
  })

  it('reads an entry without a key', () => {
    expect(parseBibtex('@misc{title = {No key}}').entries[0]).toMatchObject({ key: '', title: 'No key' })
    expect(parseBibtex('@misc{, title = {No key}}').entries[0]).toMatchObject({ key: '', title: 'No key' })
  })

  it('takes the year from date when there is no year field', () => {
    expect(parseBibtex('@online{k, date = {2021-03-09}}').entries[0]!.year).toBe('2021')
    expect(parseBibtex('@misc{k, year = {in press}}').entries[0]!.year).toBe('in press')
    expect(parseBibtex('@misc{k, year = {(2019)}}').entries[0]!.year).toBe('2019')
  })

  it('reads a DOI given as an address, and a doi.org url as the DOI', () => {
    expect(parseBibtex('@misc{k, doi = {https://doi.org/10.1/x}}').entries[0]).toMatchObject({ doi: '10.1/x', url: '' })
    expect(parseBibtex('@misc{k, url = {https://doi.org/10.1/y}}').entries[0]).toMatchObject({ doi: '10.1/y', url: '' })
    expect(parseBibtex('@misc{k, doi = {10.1000/a\\_b}}').entries[0]!.doi).toBe('10.1000/a_b')
  })

  it('finds an address in howpublished', () => {
    expect(parseBibtex('@misc{k, howpublished = {\\url{https://example.org/a~b}}}').entries[0]!.url).toBe('https://example.org/a~b')
  })

  it('uses the editors when there are no authors', () => {
    expect(parseBibtex('@book{k, editor = {Nielsen, Michael and Chuang, Isaac}}').entries[0]!.authors).toBe('Michael Nielsen, Isaac Chuang')
  })
})

describe('parseBibtex: broken entries', () => {
  it('reports an unclosed brace and reads on at the next entry', () => {
    const text = `@misc{good1, title = {One}}
@misc{broken, title = {Two
@misc{good2, title = {Three}}`
    const { entries, problems } = parseBibtex(text)
    // The unclosed title swallows up to the end; the next entry at the start of a line is still read.
    expect(entries.map((e) => e.key)).toEqual(['good1', 'good2'])
    expect(problems).toEqual([{ line: 2, key: 'broken', reason: 'a brace is opened and never closed' }])
    expect(describeProblem(problems[0]!)).toBe('Line 2 (broken): a brace is opened and never closed.')
  })

  it('reports an entry whose closing brace is missing, and reads the next one', () => {
    const text = `@misc{a, title = {One},
@misc{b, title = {Two}}`
    const { entries, problems } = parseBibtex(text)
    expect(problems).toEqual([{ line: 1, key: 'a', reason: 'a brace is missing: the next entry starts before this one’s closing “}”' }])
    expect(entries.map((e) => e.title)).toEqual(['Two'])
  })

  it('reports an extra opening brace that swallows the closing one', () => {
    const text = `@misc{broken, title = {Never {closed},
  year = 2022
}

@book{next, title = {Next}}`
    const { entries, problems } = parseBibtex(text)
    expect(problems.map((p) => p.key)).toEqual(['broken'])
    expect(entries.map((e) => e.key)).toEqual(['next'])
  })

  it('reports a field without "="', () => {
    const { entries, problems } = parseBibtex('@misc{k, title {x}}\n@misc{ok, title = {y}}')
    expect(entries.map((e) => e.key)).toEqual(['ok'])
    expect(problems[0]).toMatchObject({ line: 1, key: 'k', reason: 'the field “title” has no “=” after it' })
  })

  it('reports a value that is missing', () => {
    const { problems } = parseBibtex('@misc{k, title = , year = 2000}')
    expect(problems[0]!.reason).toBe('a value is missing before “,”')
  })

  it('reports an unclosed quote and the end of the file', () => {
    expect(parseBibtex('@misc{k, title = "open, year = 2000').problems[0]!.reason).toBe('a quotation mark is opened and never closed')
    expect(parseBibtex('@misc{k, title = {x}').problems[0]!.reason).toBe('the file ends before its closing “}”')
    expect(parseBibtex('@misc{k, title = ').problems[0]!.reason).toBe('the file ends inside it')
  })

  it('reports a broken @string and keeps going', () => {
    const { entries, problems } = parseBibtex('@string{= "x"}\n@misc{k, title = {T}}')
    expect(entries).toHaveLength(1)
    expect(problems[0]!.reason).toBe('an @string needs a name, “=” and a value')
  })

  it('never throws on garbage', () => {
    for (const junk of ['', '@', '@@@', '@misc', '@misc{', '}}}{{{', '@misc{k,,,,}', '@misc{k, a = b # }', 'x'.repeat(1000)]) {
      expect(() => parseBibtex(junk)).not.toThrow()
    }
    expect(parseBibtex('@misc{k,,,,}').entries).toHaveLength(1)
  })

  it('reads 500 entries quickly', () => {
    const one = (i: number) => `@article{key${i},\n  title = {Paper number ${i} on {Q}uantum things},\n  author = {M{\\"u}ller, Hans and Others, A.},\n  year = {2020},\n  doi = {10.1000/${i}}\n}\n`
    const text = Array.from({ length: 500 }, (_, i) => one(i)).join('\n')
    const started = performance.now()
    const { entries, problems } = parseBibtex(text)
    expect(performance.now() - started).toBeLessThan(500)
    expect(problems).toEqual([])
    expect(entries).toHaveLength(500)
    expect(entries[499]).toMatchObject({ key: 'key499', authors: 'Hans Müller, A. Others', doi: '10.1000/499', line: 499 * 7 + 1 })
  })
})

describe('authors', () => {
  it('reads both name orders, von parts and Jr', () => {
    expect(readAuthors('Jerbi, Sofiene and Vedran Dunjko')).toBe('Sofiene Jerbi, Vedran Dunjko')
    expect(readAuthors('von Neumann, Jr., John')).toBe('John von Neumann Jr.')
    expect(readAuthors('Ludwig van Beethoven')).toBe('Ludwig van Beethoven')
  })

  it('keeps braced names whole, "and" inside braces included', () => {
    expect(readAuthors('{Google Quantum AI} and {Barnes and Noble}')).toBe('Google Quantum AI, Barnes and Noble')
  })

  it('turns "and others" into et al.', () => {
    expect(readAuthors('Jerbi, S. and others')).toBe('S. Jerbi, et al.')
  })

  it('splits on AND in any case, across line breaks', () => {
    expect(readAuthors('A. One AND\n   B. Two')).toBe('A. One, B. Two')
  })
})

describe('LaTeX in values', () => {
  it('turns accents into letters, every common spelling', () => {
    expect(latexToText(`{\\'e}\\'{e}\\'e \\"o \\"{u} \\^{o} \\\`a \\~n \\c{c} \\c c \\v{s} \\u{a} \\H{o} \\k{a} \\r{u} \\={a} \\.{z} \\d{s}`)).toBe(
      'ééé ö ü ô à ñ ç ç š ă ő ą ů ā ż ṣ',
    )
  })

  it('puts an accent on a dotless i', () => {
    expect(latexToText("Mart{\\'\\i}nez Garc\\'{\\i}a")).toBe('Martínez García')
  })

  it('knows the special letters', () => {
    expect(latexToText(`Stra{\\ss}e {\\o}ystein {\\AA}ngstr{\\"o}m {\\l}{\\'o}d{\\'z} \\ae{}`)).toBe('Straße øystein Ångström łódź æ')
  })

  it('unescapes special characters, dashes and quotes', () => {
    expect(latexToText('50\\% \\& \\$5 \\#1 a\\_b pp.~1--2 A---B ``quoted\'\'')).toBe('50% & $5 #1 a_b pp. 1–2 A—B “quoted”')
  })

  it('drops formatting commands and keeps their text', () => {
    expect(latexToText('\\emph{Very} \\textbf{bold} \\textit{and} \\texttt{mono} the \\LaTeX{} way')).toBe('Very bold and mono the LaTeX way')
    expect(latexToText('\\href{https://x.org}{the site}')).toBe('the site')
  })

  it('keeps math as written', () => {
    expect(latexToText('Bounds for $\\mathrm{SU}(2)$ and {$O(n^{2})$}')).toBe('Bounds for $\\mathrm{SU}(2)$ and $O(n^{2})$')
  })

  it('keeps an unknown command readable', () => {
    expect(latexToText('\\weird{text} and \\alone here')).toBe('text and alone here')
  })

  it('reads addresses verbatim', () => {
    expect(latexToVerbatim('\\url{https://example.org/~me/a\\_b?x=1\\&y=2}')).toBe('https://example.org/~me/a_b?x=1&y=2')
  })
})
