const fs = require('fs')
const {join} = require('path')
const Git = require('simple-git/promise')
const fastGlob = require('fast-glob')
const GitUrlParse = require('git-url-parse')
const {createFileNode} = require('gatsby-source-filesystem/create-file-node')

const isAlreadyCloned = async (remote, path) => {
	const existingRemote = await Git(path).listRemote(['--get-url'])
	return existingRemote.trim() === remote.trim()
}

const getTargetBranch = async (repo, branch) => {
	if(typeof branch === 'string') return `origin/${branch}`
	return repo.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
}

const getRepo = async (path, remote, branch) => {
	// If the directory doesn't exist or is empty, clone. This will be the case if
	// our config has changed because Gatsby trashes the cache dir automatically
	// in that case.
	if(!fs.existsSync(path) || fs.readdirSync(path).length === 0){
		let opts = ['--depth', '1']
		if(typeof branch === 'string') opts.push('--branch', branch)
		await Git().clone(remote, path, opts)
		return Git(path)
	}

	if(await isAlreadyCloned(remote, path)){
		const repo = await Git(path)
		const target = await getTargetBranch(repo, branch)
		// Refresh our shallow clone with the latest commit.
		await repo
			.fetch(['--depth', '1'])
			.then(() => repo.reset(['--hard', target]))
		return repo
	}

	throw new Error(`Can't clone to target destination: ${path}`)
}

const getRemoteData = async (repo, remote) => {
	const data = GitUrlParse(remote)
	data.git_suffix = false
	data.webLink = data.toString('https')
	delete data.git_suffix
	data.ref = (await repo.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
	return data
}

const toArray = x => (Array.isArray(x) ? x : [x]).filter(a => a)
const patternEntry = ([name, pattern]) => ({name, pattern})
const parsePatterns = (patterns, defaultName) => {
	const type = Array.isArray(patterns) ? 'array' : typeof patterns
	if(type === 'array') return patterns.map(parsePatterns)
	if(type === 'string') return patternEntry([defaultName, patterns])
	if(type === 'object') return Object.entries(patterns).map(patternEntry)
}

const getLocalFiles = (cwd, patterns, defaultName) => {
	const patternGroups = toArray(parsePatterns(patterns, defaultName))
	return Promise.all(
		patternGroups.map(async ({name, pattern}) => {
			const files = await fastGlob(pattern, {cwd, absolute: true})
			return files.map(path => ({path, name}))
		})
	)
}

exports.sourceNodes = async (
	{actions: {createNode}, store, createNodeId, createContentDigest, reporter},
	{name, remote, branch, patterns = '**'}
) => {
	const programDir = store.getState().program.directory
	const localPath = join(programDir, '.cache', 'gatsby-source-git', name)

	let repo
	try{
		repo = await getRepo(localPath, remote, branch)
	}catch(e){
		return reporter.error(e)
	}

	const data = await getRemoteData(repo, remote)
	const remoteId = createNodeId(`git-remote-${name}`)

	// Create a single graph node for this git remote.
	// Filenodes sourced from it will get a field pointing back to it.
	await createNode(
		Object.assign(data, {
			id: remoteId,
			sourceInstanceName: name,
			parent: null,
			children: [],
			internal: {
				type: 'GitRemote',
				content: JSON.stringify(data),
				contentDigest: createContentDigest(data),
			},
		})
	)

	const createAndProcessNode = async ({path, name}) => {
		const options = {name, path: localPath}
		const fileNode = await createFileNode(path, createNodeId, options)
		// Add a link to the git remote node
		fileNode.gitRemote___NODE = remoteId
		// Then create the node, as if it were created by the gatsby-source
		// filesystem plugin.
		return createNode(fileNode, {name: 'gatsby-source-filesystem'})
	}

	const repoFiles = await getLocalFiles(localPath, patterns, name)
	return Promise.all(repoFiles.map(createAndProcessNode))
}

exports.onCreateNode
