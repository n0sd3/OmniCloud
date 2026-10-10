"""Real AWS CLI/rclone clients against the isolated s3GatewayServer.js fixture.
Usage: python3 backend/test/s3ClientSmoke.py private-credential-file aws-executable
The fixture uses OmniCloud's real HTTP/auth/SQLite/upload/cache services and a simulated adapter.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

credentials=json.loads(Path(sys.argv[1]).read_text())
aws=sys.argv[2]
with tempfile.TemporaryDirectory(prefix='s3-client-smoke-') as directory:
    root=Path(directory)
    environment={**os.environ,'AWS_ACCESS_KEY_ID':credentials['accessKeyId'],
                 'AWS_SECRET_ACCESS_KEY':credentials['secretAccessKey'],'AWS_DEFAULT_REGION':'auto',
                 'AWS_CONFIG_FILE':str(root/'config'),'AWS_SHARED_CREDENTIALS_FILE':str(root/'aws-credentials'),
                 'AWS_EC2_METADATA_DISABLED':'true','AWS_REQUEST_CHECKSUM_CALCULATION':'when_required',
                 'AWS_RESPONSE_CHECKSUM_VALIDATION':'when_required'}
    def run(label,args):
        result=subprocess.run(args,env=environment,capture_output=True,text=True,timeout=120)
        if result.returncode:
            raise RuntimeError(f'{label}: {result.stderr}')
        print(f'PASS {label}')
        return result.stdout
    def command(*args):return [aws,'--endpoint-url',credentials['endpoint'],*args]
    def digest(file):
        with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
    source=root/'small.txt';source.write_text('OmniCloud S3 smoke\n')
    run('ListBuckets',command('s3','ls'))
    run('ListObjects',command('s3','ls','s3://omnicloud/'))
    run('PutObject',command('s3','cp',str(source),'s3://omnicloud/teste/small.txt'))
    listing=run('List nested path',command('s3','ls','s3://omnicloud/teste/'))
    assert 'small.txt' in listing
    target=root/'download.txt';run('GetObject',command('s3','cp','s3://omnicloud/teste/small.txt',str(target)))
    assert digest(source)==digest(target);print('PASS small SHA256')
    source.write_text('Overwritten safely\n');run('Overwrite',command('s3','cp',str(source),'s3://omnicloud/teste/small.txt'))
    run('Get overwritten',command('s3','cp','s3://omnicloud/teste/small.txt',str(target)))
    assert digest(source)==digest(target);print('PASS overwrite SHA256')
    run('DeleteObject',command('s3','rm','s3://omnicloud/teste/small.txt'))
    assert all(item['Key']!='teste/small.txt' for item in json.loads(run('Confirm deleted',command('s3api','list-objects-v2','--bucket','omnicloud','--prefix','teste/'))).get('Contents',[]))
    large=root/'large.bin'
    with large.open('wb') as file:
        for _ in range(17):file.write(os.urandom(1024*1024))
    run('Multipart 17 MiB',command('s3','cp',str(large),'s3://omnicloud/backups/large.bin'))
    large_target=root/'large-download.bin';run('Download multipart',command('s3','cp','s3://omnicloud/backups/large.bin',str(large_target)))
    assert digest(large)==digest(large_target);print('PASS multipart SHA256')
    head=json.loads(run('Multipart ETag',command('s3api','head-object','--bucket','omnicloud','--key','backups/large.bin')))
    assert head['ETag'].endswith('-3"');print('PASS 3-part ETag')
    environment.update({'RCLONE_CONFIG_OC_TYPE':'s3','RCLONE_CONFIG_OC_PROVIDER':'Other',
                        'RCLONE_CONFIG_OC_ACCESS_KEY_ID':credentials['accessKeyId'],
                        'RCLONE_CONFIG_OC_SECRET_ACCESS_KEY':credentials['secretAccessKey'],
                        'RCLONE_CONFIG_OC_ENDPOINT':credentials['endpoint'],'RCLONE_CONFIG_OC_REGION':'auto',
                        'RCLONE_CONFIG_OC_FORCE_PATH_STYLE':'true','RCLONE_CONFIG_OC_NO_CHECK_BUCKET':'true'})
    run('rclone list', ['rclone','--retries','1','--low-level-retries','1','--contimeout','5s','--timeout','30s','--config',str(root/'rclone.conf'),'ls','oc:omnicloud'])
    run('rclone PutObject', ['rclone','--retries','1','--low-level-retries','1','--contimeout','5s','--timeout','30s','--config',str(root/'rclone.conf'),'copyto',str(source),'oc:omnicloud/rclone.txt'])
    run('rclone GetObject', ['rclone','--retries','1','--low-level-retries','1','--contimeout','5s','--timeout','30s','--config',str(root/'rclone.conf'),'copyto','oc:omnicloud/rclone.txt',str(target)])
    assert digest(source)==digest(target);print('PASS rclone SHA256')
    run('rclone multipart', ['rclone','--retries','1','--low-level-retries','1','--contimeout','5s','--timeout','30s','--config',str(root/'rclone.conf'),'--s3-upload-cutoff','5Mi','--s3-chunk-size','5Mi','copyto',str(large),'oc:omnicloud/rclone-large.bin'])
    run('rclone multipart download', ['rclone','--retries','1','--low-level-retries','1','--contimeout','5s','--timeout','30s','--config',str(root/'rclone.conf'),'copyto','oc:omnicloud/rclone-large.bin',str(large_target)])
    assert digest(large)==digest(large_target);print('PASS rclone multipart SHA256')
    run('rclone delete', ['rclone','--retries','1','--low-level-retries','1','--contimeout','5s','--timeout','30s','--config',str(root/'rclone.conf'),'deletefile','oc:omnicloud/rclone.txt'])
print('AWS CLI + rclone smoke passed; simulated remote, no production providers touched.')
