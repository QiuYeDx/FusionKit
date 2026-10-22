import { describe, expect, it } from 'vitest';
import { defaultCandidateOrder, matchDownloadSources } from '../../electron/main/network/download-sources';
import { SPEECH_CUDA_MANIFEST, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from '../../electron/main/speech-resources/catalog';

const urls = (match: ReturnType<typeof matchDownloadSources>) => match?.candidates.map(candidate => candidate.url);

describe('download source mapping', () => {
  it('maps every whisper.cpp speech model to the verified ModelScope copies and hf-mirror', () => {
    const whisper = SPEECH_MODEL_MANIFEST.models.filter(model => new URL(model.downloadUrl).pathname.startsWith('/ggerganov/whisper.cpp/'));
    expect(whisper.map(model => model.id)).toEqual(['large-v3-q5_0', 'large-v3', 'large-v3-turbo-q8_0']);
    for (const model of whisper) {
      const official = new URL(model.downloadUrl);
      const file = official.pathname.split('/').pop();
      const match = matchDownloadSources(model.downloadUrl);
      expect(match?.group).toBe('huggingface-whisper');
      expect(urls(match)).toEqual([
        official.href,
        `https://www.modelscope.cn/models/cjc1887415157/whisper.cpp/resolve/master/${file}`,
        `https://www.modelscope.cn/models/viggocx/whisper.cpp/resolve/master/${file}`,
        `https://www.modelscope.cn/models/iceCream2025/whisper.cpp/resolve/master/${file}`,
        `https://hf-mirror.com${official.pathname}${official.search}`,
      ]);
      expect(match!.candidates[0]).toMatchObject({ id: 'official', official: true, domestic: false });
      expect(match!.candidates.slice(1).every(candidate => !candidate.official && candidate.domestic)).toBe(true);
    }
  });

  it('maps models from other Hugging Face repositories to hf-mirror only, after the official address', () => {
    const others = SPEECH_MODEL_MANIFEST.models.filter(model => !new URL(model.downloadUrl).pathname.startsWith('/ggerganov/whisper.cpp/'));
    expect(others.map(model => model.id)).toEqual(['belle-large-v3-turbo-zh', 'anime-whisper-q8_0']);
    for (const url of [...others.map(model => model.downloadUrl), 'https://huggingface.co/other/repo/resolve/main/nested/a.bin']) {
      const official = new URL(url), match = matchDownloadSources(url);
      expect(match?.group).toBe('huggingface');
      expect(urls(match)).toEqual([official.href, `https://hf-mirror.com${official.pathname}${official.search}`]);
      expect(match!.candidates.map(candidate => [candidate.id, candidate.official, candidate.domestic])).toEqual([['official', true, false], ['hf-mirror', false, true]]);
    }
    expect(defaultCandidateOrder(matchDownloadSources(others[0]!.downloadUrl)!, 'mirror').map(candidate => candidate.id)).toEqual(['hf-mirror', 'official']);
  });

  it('maps the VAD file to jsDelivr (pinned commit) and ghfast', () => {
    const url = SPEECH_VAD_MANIFEST.vad.downloadUrl;
    const match = matchDownloadSources(url);
    expect(match?.group).toBe('github-raw');
    expect(urls(match)).toEqual([
      url,
      'https://cdn.jsdelivr.net/gh/ggml-org/whisper.cpp@f049fff95a089aa9969deb009cdd4892b3e74916/models/for-tests-silero-v6.2.0-ggml.bin',
      'https://fastly.jsdelivr.net/gh/ggml-org/whisper.cpp@f049fff95a089aa9969deb009cdd4892b3e74916/models/for-tests-silero-v6.2.0-ggml.bin',
      `https://ghfast.top/${url}`,
    ]);
  });

  it('maps GitHub release assets (the CUDA pack, later installers) to range-capable prefixes only', () => {
    const url = SPEECH_CUDA_MANIFEST.sourceArchive.downloadUrl;
    const match = matchDownloadSources(url);
    expect(match?.group).toBe('github-release');
    expect(urls(match)).toEqual([url, `https://ghfast.top/${url}`, `https://ghproxy.net/${url}`]);
    expect(urls(match)!.some(candidate => candidate.includes('gh-proxy.com'))).toBe(false);
    expect(matchDownloadSources('https://github.com/QiuYeDx/FusionKit/releases/latest/download/latest.yml')?.group).toBe('github-release');
  });

  it('leaves other addresses alone', () => {
    for (const url of [
      'https://huggingface.co/other/repo',
      'https://huggingface.co/other/repo/blob/main/a.bin',
      'https://huggingface.co/datasets/other/repo/resolve/main/a.bin',
      'https://hf-mirror.com/other/repo/resolve/main/a.bin',
      'https://github.com/ggml-org/whisper.cpp',
      'http://huggingface.co/ggerganov/whisper.cpp/resolve/x/a.bin',
      'https://user:pw@github.com/a/b/releases/download/v1/x.zip',
      'https://api.deepseek.com/v1',
      'not a url',
    ]) expect(matchDownloadSources(url), url).toBeUndefined();
  });

  it('orders sources by mode', () => {
    const match = matchDownloadSources(SPEECH_CUDA_MANIFEST.sourceArchive.downloadUrl)!;
    expect(defaultCandidateOrder(match, 'official').map(candidate => candidate.id)).toEqual(['official']);
    expect(defaultCandidateOrder(match, 'mirror').map(candidate => candidate.id)).toEqual(['ghfast', 'ghproxy', 'official']);
    expect(defaultCandidateOrder(match, 'auto').map(candidate => candidate.id)).toEqual(['official', 'ghfast', 'ghproxy']);
  });
});
