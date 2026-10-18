import { describe, expect, it } from 'vitest';
import { defaultCandidateOrder, matchDownloadSources } from '../../electron/main/network/download-sources';
import { SPEECH_CUDA_MANIFEST, SPEECH_MODEL_MANIFEST, SPEECH_VAD_MANIFEST } from '../../electron/main/speech-resources/catalog';

const urls = (match: ReturnType<typeof matchDownloadSources>) => match?.candidates.map(candidate => candidate.url);

describe('download source mapping', () => {
  it('maps every speech model to the verified ModelScope copies and hf-mirror', () => {
    for (const model of SPEECH_MODEL_MANIFEST.models) {
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
      'https://huggingface.co/other/repo/resolve/main/a.bin',
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
