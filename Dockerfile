## RUN WITH docker run -p 8089:8089 -p5000:5000 --net=host --restart=always -it airplayhub1



FROM debian:stretch

# RUN is only executed during build phase for setting filesystem thingies
RUN apt-get update
RUN apt-get install -y curl gnupg

RUN curl -sL https://deb.nodesource.com/setup_8.x | bash -
RUN apt-get install -y nodejs

RUN apt-get install -y build-essential git libavahi-compat-libdnssd-dev

RUN mkdir /airplayhub  && cd /airplayhub && git clone https://github.com/djm300/node-airplayhub.git . && npm i . && npm i .

# Docker will always run a single command, not more. So at the end of your Dockerfile, you can specify one command to run. Not more.
ADD ./start.sh /airplayhub

# For the airplay comms
EXPOSE 5000

# For the web part
EXPOSE 8089

# Entrypoint: The ENTRYPOINT specifies a command that will always be executed when the container starts.
ENTRYPOINT ["/bin/bash", "/airplayhub/start.sh"]
