import os
import pkg_resources


def calc_container(path):
    total_size = 0
    for dirpath, dirnames, filenames in os.walk(path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            total_size += os.path.getsize(fp)
    return total_size


dists = [d for d in pkg_resources.working_set]
package = []

for dist in dists:
    try:
        path = os.path.join(dist.location, dist.project_name)
        size = calc_container(path)
        if size/1000 > 1.0:
            package.append([path, size])
    except OSError:
        '{} no longer exists'.format(dist.project_name)

sorted_list = sorted(package, key=lambda x: x[1], reverse=True)
# print([i for _,i in sorted_list])

print("\n".join([f"{item[0]}: {item[1]/1000} KB" for item in sorted_list]))
