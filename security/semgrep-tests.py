import subprocess

# ruleid: sentinel-no-python-shell
subprocess.run("untrusted", shell=True)
# ok: sentinel-no-python-shell
subprocess.run(["python", "--version"], check=True)
