import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE =
  "you are an helpful ai assitant for a car garage named goCar and your main goal is to help the user book appointment for their car repair or service. do not haluinate";
const VOICE = "alloy";
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all("/incoming-call", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    // creating openai websocket
    console.log("Client connected");

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    let streamSid = null;
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text","audio"],
          temperature: 0.8,
          tools: [
            {
              type: "function",
              name: "sheduleAppointment",
              description:
                "Helps user book/shedule an appointment with the garage for car repair/service example prompt: i want to book and appointment for car service",
              parameters: {
                type: "object",
                properties: {
                  date: { type: "string" },
                  email: { type: "string" },
                  name: { type: "string" },
                },
                required: ["date", "email", "name"],
              },
            },
            {
              type: "function",
              name: "endConversation",
              description:
                "ends the conversation once the user query/task is done",
              parameters: {},
            },
          ],
        },
      };

      openAiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["text","audio"],
            instructions:
              "Greet the user by saying welcome to Go Car and ask them how can you help",
          },
        })
      );

      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
    });

    // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (response.type === "response.function_call_arguments.done") {
          console.log("function call success", response);
          let argument = JSON.parse(response.arguments);

          if (response.name === "sheduleAppointment") {
            try {
              console.log(`called sheduleAppointment ${argument}`);
              openAiWs.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    output: `the appointment is sheduled`,
                  },
                })
              );

              //immediately respond to user.
              openAiWs.send(
                JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: ["text","audio"],
                    instructions: `tell the user your: Hi ${argument.name} your appointment for ${argument.date} is sheduled, you will recive a confirmation mail on ${argument.email}`,
                  },
                })
              );
            } catch (error) {
              console.error(`Error processing function call: ${error}`);
            }
          }

          if (response.name === "endConversation") {
            try {
              openAiWs.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "function_call_output",
                    output: "the query is resolved",
                  },
                })
              );

              //immediately respond to user.
              openAiWs.send(
                JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: ["text", "audio"],
                    instructions: `thank the user and wish them a nice day ahead`,
                  },
                })
              );

              if (
                openAiWs &&
                openAiWs.readyState === WebSocket.OPEN &&
                connection &&
                connection.readyState === WebSocket.OPEN
              ) {
                openAiWs.close();
                connection.close();
                console.log("Manually closed the Twilio WebSocket");
                console.log("Manually closed the OpenAI WebSocket");
              }
            } catch (error) {
              console.error(`Error processing function call: ${error}`);
            }
          }
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error("Error processing OpenAI message:", error);
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "media":
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started");
            break;
          default:
            console.log("Received non-media event:");
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
